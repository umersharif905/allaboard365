const express = require('express');
const {
  buildMemberListSummarySelectSql,
  MEMBER_LIST_SUMMARY_JOINS_SQL,
} = require('../utils/memberStatsSql');
const {
  MEMBER_LIST_ENROLLMENT_STATUS_SQL,
  MEMBER_LIST_ENROLLMENT_LINK_SENT_AT_SQL,
  MEMBER_LIST_MONTHLY_PREMIUM_SQL,
} = require('../utils/memberEnrollmentStatusSql');
const { getEnrollmentLifecycleFilterSql } = require('../utils/memberEnrollmentLifecycleFilterSql');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { getUserRoles } = require('../middleware/auth');
const { PricingEngine } = require('../services/pricing');
const UserRolesService = require('../services/shared/user-roles.service');
const MemberProductsService = require('../services/shared/member-products.service');
const PaymentMethodService = require('../services/PaymentMethodService');
const {
    fetchPreviousDefaultProcessorPmId,
    runPaymentMethodRecurringSync,
} = require('../services/paymentMethodRecurringRouteHelper');
const PaymentDatabaseService = require('../services/paymentDatabaseService');
const DimeService = require('../services/dimeService');
const dimeCardBrand = require('../services/dimeCardBrand');
const encryptionService = require('../services/encryptionService');
const { resolveAchRoutingForCharge } = require('../utils/achRouting');
const UserEmailService = require('../services/shared/user-email.service');
const HouseholdMemberRemovalService = require('../services/members/householdMemberRemoval.service');
const {
    swapHouseholdMemberIdPrefix,
    computePrefixSwapForGroupChange
} = require('../utils/householdMemberIdPrefix');
const { handleMemberScopedIndividualInvoicePdfRequest } = require('../services/individualInvoicePdf.service');
const {
    parseEffectiveDateParts,
    buildEffectiveDateExistsSql,
    bindEffectiveDateParams,
    buildEffectiveDateExistsPredicate,
    buildEnrollmentStatusExistsSql,
    bindAsOfDateParam
} = require('../utils/memberEffectiveDateFilter');
const {
  buildMemberListProductFilterExistsSql,
  ENROLLMENT_TYPE_PRODUCT_LIKE_SQL,
} = require('../utils/memberListProductFilterSql');

/** Decrypt SSN from DB; return formatted XXX-XX-XXXX or null. */
function decryptSSN(encryptedSSN) {
  if (!encryptedSSN) return null;
  try {
    if (encryptedSSN.match(/^\d{3}-\d{2}-\d{4}$/)) return encryptedSSN;
    return encryptionService.decrypt(encryptedSSN);
  } catch (err) {
    return null;
  }
}

/** Return last 4 digits of SSN for display (***-**-XXXX). */
function getSSNLast4(encryptedSSN) {
  if (!encryptedSSN) return null;
  const decrypted = decryptSSN(encryptedSSN);
  const digits = (decrypted || encryptedSSN).toString().replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Nine-digit string for admin edit flows (decrypt from oe.Members.SSN). */
function getSSNDigitsPlain(rawSsn) {
  if (!rawSsn) return null;
  const decrypted = decryptSSN(rawSsn);
  if (decrypted) {
    const d = String(decrypted).replace(/\D/g, '');
    if (d.length === 9) return d;
  }
  const rawDigits = String(rawSsn).replace(/\D/g, '');
  if (rawDigits.length === 9) return rawDigits;
  return null;
}

function formatAndEncryptSSN(ssn) {
  if (!ssn || typeof ssn !== 'string') return null;
  const digits = ssn.replace(/\D/g, '');
  if (digits.length !== 9) return null;
  const formatted = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 9)}`;
  try {
    return encryptionService.encrypt(formatted);
  } catch (err) {
    return null;
  }
}
// const { authorize } = require('../middleware/auth');
// const requireTenantAccess = require('../middleware/requireTenantAccess');

// Authorization middleware
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        const userRoles = getUserRoles(req.user);
        if (!allowedRoles.some(role => userRoles.includes(role))) {
            return res.status(403).json({
                success: false,
                message: 'Insufficient permissions',
                required: allowedRoles,
                current: userRoles
            });
        }
        next();
    };
};

// GET Members (SysAdmin only - all members across all tenants)
router.get('/', authorize(['SysAdmin']), async (req, res) => {
    try {
        const { 
            status, 
            search, 
            billType,
            memberTypeFilter,
            relationshipType,
            tenantId,
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
        
        console.log('🔍 GET /api/members (SysAdmin) - Request received');
        console.log('👤 SysAdmin User:', { 
            userId: req.user?.UserId,
            email: req.user?.Email
        });
        console.log('📋 Query params:', req.query);
        
        const pool = await getPool();
        
        // Calculate pagination
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const offset = (pageNum - 1) * limitNum;
        
        // Build base query
        let query = `
            SELECT 
                m.MemberId, m.UserId, m.GroupId, m.HouseholdId, m.MemberSequence,
                m.HouseholdMemberID,
                m.RelationshipType, m.Status, m.CreatedDate, m.IsPendingMigration,
                FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                FORMAT(m.HireDate, 'yyyy-MM-dd') as HireDate,
                m.Gender, m.Address, m.City, m.State, m.Zip,
                m.WorkLocation, m.LocationId, m.JobPosition, m.Tier, m.TobaccoUse,
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
                a.AgencyId,
                agy.AgencyName
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            LEFT JOIN oe.Tenants t ON u.TenantId = t.TenantId
            LEFT JOIN oe.Agents a ON m.AgentId = a.AgentId
            LEFT JOIN oe.Users ag ON a.UserId = ag.UserId
            LEFT JOIN oe.Agencies agy ON a.AgencyId = agy.AgencyId
            WHERE 1=1
        `;
        
        // Build count query
        let countQuery = `
            SELECT COUNT(*) as total
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            LEFT JOIN oe.Agents a ON m.AgentId = a.AgentId
            WHERE 1=1
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
        
        if (tenantId) {
            const tenantCondition = ' AND u.TenantId = @tenantId';
            query += tenantCondition;
            countQuery += tenantCondition;
            request.input('tenantId', sql.UniqueIdentifier, tenantId);
            countRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
            summaryRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
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
        
        const sysAdminLifecycleFilterSql = getEnrollmentLifecycleFilterSql(enrollmentLifecycleStatus);
        if (sysAdminLifecycleFilterSql) {
            query += sysAdminLifecycleFilterSql;
            countQuery += sysAdminLifecycleFilterSql;
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
        
        console.log('✅ SysAdmin members query result:', { 
            membersCount: members.length,
            total: total,
            page: pageNum,
            limit: limitNum,
            scope: 'All tenants'
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
        console.error('❌ Error fetching members:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error while fetching members',
            error: {
                message: error.message,
                code: 'MEMBERS_FETCH_ERROR'
            }
        });
    }
});

// GET current user's member information
router.get(
  '/me',
  authorize(['Admin', 'SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']),
  async (req, res) => {
    try {
      const userId = req.user.UserId;
      const pool = await getPool();

      const query = `
        SELECT 
          m.MemberId, m.UserId, m.GroupId, m.HouseholdId, m.MemberSequence,
          m.RelationshipType, m.Status, m.CreatedDate, 
          FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth, 
          m.Gender, m.Address, m.City, m.State, m.Zip,
          m.HouseholdMemberID,
          u.FirstName, u.LastName, u.Email, u.PhoneNumber,
          CASE WHEN g.GroupId IS NOT NULL THEN 'LB' ELSE 'SB' END as BillType,
          g.Name as GroupName,
          CASE m.RelationshipType
              WHEN 'P' THEN 'Primary'
              WHEN 'S' THEN 'Spouse'
              WHEN 'C' THEN 'Child'
              ELSE 'Unknown'
          END as RelationshipDescription,
          tn.MemberIDPrefix as TenantMemberIDPrefix,
          tn.IndividualMemberIDPrefix as TenantIndividualMemberIDPrefix
        FROM oe.Members m
        JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
        LEFT JOIN oe.Tenants tn ON u.TenantId = tn.TenantId
        WHERE m.UserId = @userId
      `;

      const request = pool.request();
      // This is the fix: Changed sql.VarChar to sql.UniqueIdentifier to match the database schema.
      request.input('userId', sql.UniqueIdentifier, userId);

      const result = await request.query(query);

      if (!result.recordset || result.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No member profile found for current user'
        });
      }

      console.log('🔍 Member profile:', result.recordset[0]);
      res.json({ success: true, data: result.recordset[0] });
    } catch (error) {
      console.error('❌ Error fetching current user member profile:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch member profile' });
    }
  }
);

// GET /api/members/export - Export all members to CSV
// Only available to SysAdmin and TenantAdmin
// IMPORTANT: This route must be defined BEFORE /:id to prevent "export" from being matched as an ID
router.get('/export', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const {
            status = '',
            search,
            tenantId,
            groupId,
            agentId,
            agencyId,
            state,
            billType,
            memberTypeFilter,
            relationshipType,
            householdOnly,
            enrollmentStatus = 'all', // active | futureEffective | effectiveCurrently | all
            enrollmentLifecycleStatus,
            productId,
            vendorId
        } = req.query;

        console.log('📊 GET /api/members/export - Generating member export');
        console.log('📋 Filters:', req.query);

        const pool = await getPool();
        const request = pool.request();

        // Helper to validate GUID format (skip filter if invalid)
        const isValidGuid = (value) => {
            if (!value || typeof value !== 'string') return false;
            const guidPattern = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
            return guidPattern.test(value.trim());
        };

        // Build WHERE clause based on filters
        let whereConditions = [];
        
        if (status) {
            whereConditions.push(`m.Status = @status`);
            request.input('status', sql.NVarChar, status);
        }
        
        if (search) {
            whereConditions.push(`(
                u.FirstName LIKE @search OR 
                u.LastName LIKE @search OR 
                u.Email LIKE @search OR
                u.PhoneNumber LIKE @search
            )`);
            request.input('search', sql.NVarChar, `%${search}%`);
        }
        
        // Only add GUID filters if they're valid - skip invalid ones silently
        if (tenantId && isValidGuid(tenantId)) {
            whereConditions.push(`u.TenantId = @tenantId`);
            request.input('tenantId', sql.UniqueIdentifier, tenantId.trim());
        }
        
        if (groupId && isValidGuid(groupId)) {
            whereConditions.push(`m.GroupId = @groupId`);
            request.input('groupId', sql.UniqueIdentifier, groupId.trim());
        }
        
        if (agentId && isValidGuid(agentId)) {
            whereConditions.push(`m.AgentId = @agentId`);
            request.input('agentId', sql.UniqueIdentifier, agentId.trim());
        }
        
        if (agencyId && isValidGuid(agencyId)) {
            whereConditions.push(`a.AgencyId = @agencyId`);
            request.input('agencyId', sql.UniqueIdentifier, agencyId.trim());
        }
        
        if (state) {
            whereConditions.push(`m.State = @state`);
            request.input('state', sql.NVarChar, state);
        }

        const exportMemberTypeNorm = (() => {
            const mt = String(memberTypeFilter || '').toLowerCase();
            if (mt === 'group' || mt === 'individual') return mt;
            if (billType === 'LB') return 'group';
            if (billType === 'SB') return 'individual';
            return '';
        })();
        if (exportMemberTypeNorm === 'group') {
            whereConditions.push('m.GroupId IS NOT NULL');
        } else if (exportMemberTypeNorm === 'individual') {
            whereConditions.push('m.GroupId IS NULL');
        }

        if (relationshipType) {
            whereConditions.push('m.RelationshipType = @relationshipType');
            request.input('relationshipType', sql.NVarChar, relationshipType);
        }

        if (householdOnly === 'true') {
            whereConditions.push('m.HouseholdId IS NOT NULL');
        }

        const exportLifecycleSql = getEnrollmentLifecycleFilterSql(enrollmentLifecycleStatus);
        if (exportLifecycleSql) {
            const pred = exportLifecycleSql.trim().replace(/^\s*AND\s+/i, '');
            if (pred) whereConditions.push(pred);
        }

        const exportEdParsed = parseEffectiveDateParts(req.query);
        if (exportEdParsed.error) {
            return res.status(400).json({ success: false, message: exportEdParsed.error });
        }
        const exportEnrollmentStatusSql = buildEnrollmentStatusExistsSql(enrollmentStatus);
        if (exportEnrollmentStatusSql) {
            const pred = exportEnrollmentStatusSql.trim().replace(/^\s*AND\s+/i, '');
            if (pred) whereConditions.push(pred);
            bindAsOfDateParam(exportEdParsed.parts, request);
        }
        if (exportEdParsed.parts && !exportEnrollmentStatusSql) {
            const pred = buildEffectiveDateExistsPredicate(exportEdParsed.parts);
            if (pred) whereConditions.push(pred);
            bindEffectiveDateParams(exportEdParsed.parts, request);
        }

        if (productId && isValidGuid(productId)) {
            whereConditions.push(buildMemberListProductFilterExistsSql());
            request.input('productId', sql.UniqueIdentifier, productId.trim());
        }

        if (vendorId && isValidGuid(vendorId)) {
            whereConditions.push(`(
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
            )`);
            request.input('vendorId', sql.UniqueIdentifier, vendorId.trim());
        }

        // Apply role-based filtering
        const userRoles = getUserRoles(req.user);
        if (userRoles.includes('TenantAdmin')) {
            // TenantAdmin can only export members within their tenant
            const userTenantId = req.user.TenantId;
            if (userTenantId && isValidGuid(userTenantId)) {
                whereConditions.push(`u.TenantId = @userTenantId`);
                request.input('userTenantId', sql.UniqueIdentifier, userTenantId.trim());
            } else {
                console.warn('⚠️ TenantAdmin user missing or invalid TenantId, skipping tenant filter');
            }
        }
        // SysAdmin can export all members (no additional filtering needed)

        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

        // Main query to get all members with their basic info
        const membersQuery = `
            SELECT 
                m.MemberId,
                m.HouseholdMemberID,
                m.HouseholdId,
                m.RelationshipType,
                m.Tier,
                m.TobaccoUse,
                m.Gender,
                FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                m.Address,
                m.City,
                m.State,
                m.Zip,
                u.FirstName,
                u.LastName,
                u.Email,
                g.Name as GroupName,
                CASE m.RelationshipType
                    WHEN 'P' THEN 'Primary'
                    WHEN 'S' THEN 'Spouse'
                    WHEN 'C' THEN 'Child'
                    ELSE 'Unknown'
                END as RelationshipDescription
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            LEFT JOIN oe.Agents a ON m.AgentId = a.AgentId
            ${whereClause}
            ORDER BY 
                m.HouseholdId,
                CASE m.RelationshipType
                    WHEN 'P' THEN 1
                    WHEN 'S' THEN 2
                    WHEN 'C' THEN 3
                    ELSE 4
                END,
                m.MemberSequence
        `;

        const membersResult = await request.query(membersQuery);
        const members = membersResult.recordset || [];

        if (members.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No members found matching the criteria'
            });
        }

        // Get all enrollments for these members
        // Filter out invalid GUIDs and null/undefined values
        const guidRegex = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
        const memberIds = members
            .map(m => {
                if (!m) {
                    console.warn('⚠️ Skipping null/undefined member in export');
                    return null;
                }
                // Handle both string and object formats (SQL may return as buffer or object)
                const id = m.MemberId || m.memberId;
                if (!id) {
                    console.warn('⚠️ Member missing MemberId:', m);
                    return null;
                }
                // Convert to string, handling buffer objects from SQL
                const idString = Buffer.isBuffer(id) ? id.toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5') : String(id).trim();
                return idString || null;
            })
            .filter(id => {
                if (!id) return false;
                // Check if it's a valid GUID format
                const isValid = guidRegex.test(id);
                if (!isValid) {
                    console.warn(`⚠️ Invalid MemberId format skipped: ${id} (type: ${typeof id})`);
                }
                return isValid;
            });
        
        console.log(`📊 Export: Found ${members.length} members, ${memberIds.length} valid member IDs`);
        
        const enrollmentsRequest = pool.request();
        
        // Build parameterized IN clause for member IDs
        if (memberIds.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No members found matching the criteria'
            });
        }
        
        // Use parameterized query for member IDs (limit to prevent too many parameters)
        // For very large exports, we could batch this, but for now we'll handle up to 1000 members
        let memberIdInClause = '';
        memberIds.slice(0, 1000).forEach((memberId, index) => {
            const paramName = `MemberId${index}`;
            enrollmentsRequest.input(paramName, sql.UniqueIdentifier, memberId);
            memberIdInClause += (index > 0 ? ', ' : '') + `@${paramName}`;
        });
        
        const enrollmentsQuery = `
            SELECT 
                e.EnrollmentId,
                e.MemberId,
                e.ProductId,
                e.Status,
                FORMAT(e.EffectiveDate, 'yyyy-MM-dd') as EffectiveDate,
                FORMAT(e.TerminationDate, 'yyyy-MM-dd') as TerminationDate,
                e.PremiumAmount,
                e.EnrollmentType,
                e.EnrollmentDetails,
                p.Name as ProductName,
                p.RequiredDataFields,
                -- Get ConfigValue from ProductPricing if available
                pp.ConfigValue1,
                pp.ConfigValue2,
                pp.ConfigValue3,
                pp.ConfigValue4,
                pp.ConfigValue5
            FROM oe.Enrollments e
            LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
            LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
            LEFT JOIN oe.ProductPricing pp ON e.ProductId = pp.ProductId 
                AND pp.TierType = m.Tier 
                AND pp.TobaccoStatus = CASE 
                    WHEN m.TobaccoUse = 'Y' THEN 'Tobacco'
                    WHEN m.TobaccoUse = 'N' THEN 'Non-Tobacco'
                    ELSE 'Unknown'
                END
            WHERE e.MemberId IN (${memberIdInClause})
                AND (
                    ${
                        enrollmentStatus === 'active'
                            ? `(
                                (e.Status = 'Active' OR e.Status = 'Pending')
                                AND (e.EffectiveDate IS NULL OR CAST(e.EffectiveDate AS DATE) <= @asOfDate)
                                AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) > @asOfDate)
                            )`
                            : enrollmentStatus === 'futureEffective'
                                ? `(
                                    (e.Status = 'Active' OR e.Status = 'Pending')
                                    AND e.EffectiveDate IS NOT NULL
                                    AND CAST(e.EffectiveDate AS DATE) > @asOfDate
                                    AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) > @asOfDate)
                                )`
                                : enrollmentStatus === 'effectiveCurrently'
                                    ? `(
                                        (e.Status = 'Active' OR e.Status = 'Pending')
                                        AND (e.EffectiveDate IS NULL OR CAST(e.EffectiveDate AS DATE) <= @asOfDate)
                                        AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) > @asOfDate)
                                    )`
                                    : `e.Status IN ('Active', 'Pending', 'Inactive', 'Cancelled', 'Denied')`
                    }
                )
                AND (
                    e.EnrollmentType = 'Product' 
                    OR e.EnrollmentType IS NULL
                    OR e.EnrollmentType = 'SystemFee'
                    OR e.EnrollmentType = 'PaymentProcessingFee'
                )
            ORDER BY e.MemberId, e.EffectiveDate DESC
        `;

        if (exportEnrollmentStatusSql) {
            bindAsOfDateParam(exportEdParsed.parts, enrollmentsRequest);
        }

        const enrollmentsResult = await enrollmentsRequest.query(enrollmentsQuery);
        const enrollments = enrollmentsResult.recordset || [];

        // Separate enrollments by type
        const feesByHousehold = {};
        enrollments.forEach(enrollment => {
            if (enrollment.EnrollmentType === 'SystemFee' || enrollment.EnrollmentType === 'PaymentProcessingFee') {
                const householdId = members.find(m => String(m.MemberId).trim() === String(enrollment.MemberId).trim())?.HouseholdId;
                if (householdId) {
                    if (!feesByHousehold[householdId]) {
                        feesByHousehold[householdId] = {};
                    }
                    feesByHousehold[householdId][enrollment.EnrollmentType] = (feesByHousehold[householdId][enrollment.EnrollmentType] || 0) + (parseFloat(enrollment.PremiumAmount) || 0);
                }
            }
        });

        // Group enrollments by member
        // Convert MemberId to string for consistent dictionary key access
        const enrollmentsByMember = {};
        enrollments.forEach(enrollment => {
            if (!enrollment || !enrollment.MemberId) {
                console.warn('⚠️ Skipping enrollment with missing MemberId');
                return;
            }
            const memberIdKey = String(enrollment.MemberId).trim();
            if (!enrollmentsByMember[memberIdKey]) {
                enrollmentsByMember[memberIdKey] = [];
            }
            enrollmentsByMember[memberIdKey].push(enrollment);
        });

        // Helper function to extract ConfigValue. Source-of-truth is the live ProductPricing.ConfigValue1
        // resolved via oe.Enrollments.ProductPricingId — this lets admin relabels (e.g. 3000→2500)
        // propagate to every existing enrollment without rewriting per-enrollment snapshots.
        // The EnrollmentDetails snapshot is a historical record and is used only as a fallback for
        // rows where ProductPricing.ConfigValue1 is NULL (older data / products without a pricing-keyed
        // config field).
        const extractConfigValue = (enrollment) => {
            try {
                // Prefer live ProductPricing.ConfigValue1
                if (enrollment.ConfigValue1 && enrollment.ConfigValue1 !== 'Default') {
                    return enrollment.ConfigValue1;
                }

                // Fallback to snapshot on oe.Enrollments.EnrollmentDetails
                if (enrollment.EnrollmentDetails) {
                    const details = typeof enrollment.EnrollmentDetails === 'string'
                        ? JSON.parse(enrollment.EnrollmentDetails)
                        : enrollment.EnrollmentDetails;

                    if (details.configuration && details.configuration !== 'Default') return details.configuration;
                    if (details.configValue) return details.configValue;
                    if (details.ConfigValue) return details.ConfigValue;
                    if (details.configValues && details.configValues.ConfigValue1) return details.configValues.ConfigValue1;
                }

                return enrollment.ConfigValue1 || '';
            } catch (e) {
                console.warn('Error parsing EnrollmentDetails:', e);
                return enrollment.ConfigValue1 || '';
            }
        };

        // Helper function to determine enrollment status based on dates
        const getEnrollmentStatus = (enrollment) => {
            if (!enrollment) return '';
            
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            const effectiveDate = enrollment.EffectiveDate ? new Date(enrollment.EffectiveDate) : null;
            const terminationDate = enrollment.TerminationDate ? new Date(enrollment.TerminationDate) : null;
            
            if (enrollment.Status === 'Denied' || enrollment.Status === 'Cancelled') {
                return 'Declined Coverage';
            }
            
            if (terminationDate && terminationDate < today) {
                return 'Terminated';
            }
            
            if (effectiveDate && effectiveDate > today) {
                return 'Future Active';
            }
            
            if (enrollment.Status === 'Active' || (effectiveDate && effectiveDate <= today && (!terminationDate || terminationDate >= today))) {
                return 'Active';
            }
            
            return enrollment.Status || '';
        };

        // Helper function to collect all config values from products
        const getAllConfigValues = (productEnrollments) => {
            const configValues = productEnrollments
                .map(e => extractConfigValue(e))
                .filter(val => val && val.trim() !== '');
            
            // Remove duplicates and return comma-separated
            return [...new Set(configValues)].join(',');
        };

        // Build CSV data
        const csvRows = [];
        
        // CSV Headers
        // Note: Using HouseholdMemberID (user-friendly ID) instead of MemberId (GUID) for export
        const headers = [
            'HouseholdMemberID',
            'Name',
            'DOB',
            'Address',
            'Gender',
            'Tobacco Y/N',
            'Tier',
            'Primary/Spouse/Child',
            'Group Name',
            'EffectiveDate',
            'TerminationDate',
            'Status',
            'ProductName',
            'Product2',
            'Product3',
            'Product4',
            'ConfigValue/Unshared Amount',
            'PremiumAmount',
            'MerchantFees',
            'SystemFees',
            'TotalPremium'
        ];
        
        csvRows.push(headers.join(','));

        // Helper to escape CSV values
        const escapeCsv = (value) => {
            if (value === null || value === undefined || value === '') return '';
            const str = String(value);
            if (str.includes('"') || str.includes(',') || str.includes('\n')) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        };

        // Process members returned by the filtered query.
        const processedHouseholds = new Set();
        
        members.forEach(member => {
            // Validate member has valid MemberId
            if (!member || !member.MemberId) {
                console.warn('⚠️ Skipping member with missing MemberId');
                return;
            }
            
            const memberIdKey = String(member.MemberId).trim();
            const householdId = member.HouseholdId;
            const isPrimary = member.RelationshipType === 'P';
            
            // Skip dependents if we've already processed this household's primary member
            if (!isPrimary && processedHouseholds.has(householdId)) {
                return;
            }
            
            if (isPrimary) {
                processedHouseholds.add(householdId);
            }

            // Get member's enrollments using string key
            const memberEnrollments = enrollmentsByMember[memberIdKey] || [];
            
            // Separate product enrollments from fees
            const productEnrollments = memberEnrollments.filter(e => 
                (e.EnrollmentType === 'Product' || e.EnrollmentType === null || e.EnrollmentType === undefined)
                && e.ProductId !== '00000000-0000-0000-0000-000000000000'
            );
            
            // Primary members are already filtered by household inclusion logic above
            // Dependents are always included if their primary is included
            
            // Get household fees
            const householdFees = feesByHousehold[householdId] || {};
            const systemFees = householdFees.SystemFee || 0;
            const merchantFees = householdFees.PaymentProcessingFee || 0;
            
            // Calculate totals
            const premiumAmount = productEnrollments.reduce((sum, e) => sum + (parseFloat(e.PremiumAmount) || 0), 0);
            const totalPremium = premiumAmount + systemFees + merchantFees;
            
            // Get up to 4 products
            const products = productEnrollments.slice(0, 4);
            const product1 = products[0] || null;
            const product2 = products[1] || null;
            const product3 = products[2] || null;
            const product4 = products[3] || null;
            
            // Build address string
            const addressParts = [
                member.Address,
                member.City,
                member.State,
                member.Zip
            ].filter(Boolean);
            const fullAddress = addressParts.join(', ');
            
            // Convert TobaccoUse to Y/N
            const tobaccoYN = member.TobaccoUse === 'Y' ? 'Y' : (member.TobaccoUse === 'N' ? 'N' : '');
            
            // Get effective date and termination date from first product
            const effectiveDate = product1 ? product1.EffectiveDate : '';
            const terminationDate = product1 ? product1.TerminationDate : '';
            
            // Get enrollment status from first product
            const enrollmentStatusText = product1 ? getEnrollmentStatus(product1) : '';
            
            // Collect all config values from all products (comma-separated)
            const allConfigValues = getAllConfigValues(productEnrollments);
            
            // Build row
            const row = [
                escapeCsv(member.HouseholdMemberID || ''),
                escapeCsv(`${member.FirstName} ${member.LastName}`),
                escapeCsv(member.DateOfBirth || ''),
                escapeCsv(fullAddress),
                escapeCsv(member.Gender || ''),
                escapeCsv(tobaccoYN),
                escapeCsv(member.Tier || ''),
                escapeCsv(member.RelationshipDescription || ''),
                escapeCsv(member.GroupName || ''),
                escapeCsv(effectiveDate),
                escapeCsv(terminationDate),
                escapeCsv(enrollmentStatusText),
                escapeCsv(product1 ? product1.ProductName : ''),
                escapeCsv(product2 ? product2.ProductName : ''),
                escapeCsv(product3 ? product3.ProductName : ''),
                escapeCsv(product4 ? product4.ProductName : ''),
                escapeCsv(allConfigValues),
                premiumAmount.toFixed(2),
                merchantFees.toFixed(2),
                systemFees.toFixed(2),
                totalPremium.toFixed(2)
            ];
            
            csvRows.push(row.join(','));
            
            // Add dependents below primary member
            // Always include dependents if their primary member is included
            if (isPrimary && householdId) {
                const dependents = members.filter(m => 
                    m.HouseholdId === householdId && 
                    m.RelationshipType !== 'P' &&
                    m.MemberId !== member.MemberId
                );
                
                dependents.forEach(dependent => {
                    if (!dependent || !dependent.MemberId) {
                        console.warn('⚠️ Skipping dependent with missing MemberId');
                        return;
                    }
                    const dependentIdKey = String(dependent.MemberId).trim();
                    const dependentEnrollments = enrollmentsByMember[dependentIdKey] || [];
                    const dependentProducts = dependentEnrollments.filter(e => 
                        (e.EnrollmentType === 'Product' || e.EnrollmentType === null || e.EnrollmentType === undefined)
                        && e.ProductId !== '00000000-0000-0000-0000-000000000000'
                    );
                    
                    // Always include dependents if their primary member is included (don't filter them out)
                    
                    const dependentProductsList = dependentProducts.slice(0, 4);
                    const depProduct1 = dependentProductsList[0] || null;
                    const depProduct2 = dependentProductsList[1] || null;
                    const depProduct3 = dependentProductsList[2] || null;
                    const depProduct4 = dependentProductsList[3] || null;
                    
                    const depPremium = dependentProducts.reduce((sum, e) => sum + (parseFloat(e.PremiumAmount) || 0), 0);
                    const depTotalPremium = depPremium; // Dependents don't have separate fees
                    
                    const depAddressParts = [
                        dependent.Address,
                        dependent.City,
                        dependent.State,
                        dependent.Zip
                    ].filter(Boolean);
                    const depFullAddress = depAddressParts.join(', ');
                    
                    const depTobaccoYN = dependent.TobaccoUse === 'Y' ? 'Y' : (dependent.TobaccoUse === 'N' ? 'N' : '');
                    
                    const depEffectiveDate = depProduct1 ? depProduct1.EffectiveDate : '';
                    const depTerminationDate = depProduct1 ? depProduct1.TerminationDate : '';
                    const depEnrollmentStatusText = depProduct1 ? getEnrollmentStatus(depProduct1) : '';
                    
                    // Collect all config values from all dependent products (comma-separated)
                    const depAllConfigValues = getAllConfigValues(dependentProducts);
                    
                    const depRow = [
                        escapeCsv(dependent.HouseholdMemberID || ''),
                        escapeCsv(`${dependent.FirstName} ${dependent.LastName}`),
                        escapeCsv(dependent.DateOfBirth || ''),
                        escapeCsv(depFullAddress),
                        escapeCsv(dependent.Gender || ''),
                        escapeCsv(depTobaccoYN),
                        escapeCsv(dependent.Tier || ''),
                        escapeCsv(dependent.RelationshipDescription || ''),
                        escapeCsv(dependent.GroupName || ''),
                        escapeCsv(depEffectiveDate),
                        escapeCsv(depTerminationDate),
                        escapeCsv(depEnrollmentStatusText),
                        escapeCsv(depProduct1 ? depProduct1.ProductName : ''),
                        escapeCsv(depProduct2 ? depProduct2.ProductName : ''),
                        escapeCsv(depProduct3 ? depProduct3.ProductName : ''),
                        escapeCsv(depProduct4 ? depProduct4.ProductName : ''),
                        escapeCsv(depAllConfigValues),
                        depPremium.toFixed(2),
                        '0.00', // Dependents don't have separate merchant fees
                        '0.00', // Dependents don't have separate system fees
                        depTotalPremium.toFixed(2)
                    ];
                    
                    csvRows.push(depRow.join(','));
                });
            }
        });

        const csvContent = csvRows.join('\n');
        const today = new Date().toISOString().split('T')[0];
        const filename = `members-export-${today}.csv`;

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csvContent);

        console.log(`✅ Export generated successfully: ${members.length} members, ${csvRows.length - 1} rows`);

    } catch (error) {
        console.error('❌ Error generating member export:', error);
        console.error('❌ Error stack:', error.stack);
        console.error('❌ Request query:', req.query);
        console.error('❌ Request user:', req.user);
        
        // Return 400 for validation errors, 500 for server errors
        const statusCode = error.message && error.message.includes('Validation') ? 400 : 500;
        res.status(statusCode).json({
            success: false,
            message: error.message || 'Failed to generate member export',
            error: {
                message: error.message,
                code: 'EXPORT_ERROR',
                details: process.env.NODE_ENV === 'development' ? error.stack : undefined
            }
        });
    }
});

// GET member administrative history (group changes, etc.)
/**
 * GET /api/members/:id/invoices/:invoiceId/pdf
 * Individual invoice PDF scoped to member household (member management UI).
 */
router.get(
    '/:id/invoices/:invoiceId/pdf',
    authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin', 'Member']),
    async (req, res) => {
        try {
            await handleMemberScopedIndividualInvoicePdfRequest(req, res, req.params.id, req.params.invoiceId);
        } catch (err) {
            console.error('GET /api/members/:id/invoices/:invoiceId/pdf error:', err);
            res.status(500).json({
                success: false,
                message: 'Failed to generate invoice PDF',
                error: err.message
            });
        }
    }
);

router.get('/:id/history', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { id } = req.params;
        const guidRegex = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
        if (!id || !guidRegex.test(id)) {
            return res.status(400).json({ success: false, message: 'Invalid member ID format' });
        }
        const pool = await getPool();
        const userRoles = getUserRoles(req.user);

        const mreq = pool.request();
        mreq.input('memberId', sql.UniqueIdentifier, id);
        const mres = await mreq.query('SELECT TenantId FROM oe.Members WHERE MemberId = @memberId');
        if (mres.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }
        const memberTenantId = mres.recordset[0].TenantId;
        if (userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
            const tid = req.user.TenantId;
            if (!tid || !memberTenantId || String(memberTenantId).toLowerCase() !== String(tid).toLowerCase()) {
                return res.status(403).json({ success: false, message: 'Not authorized to view member history' });
            }
        }

        const hreq = pool.request();
        hreq.input('memberId', sql.UniqueIdentifier, id);
        const tableCheck = await pool.request().query(`
            SELECT CASE WHEN OBJECT_ID('oe.MemberEventLog', 'U') IS NOT NULL THEN 1 ELSE 0 END AS HasTable
        `);
        if (!tableCheck.recordset[0]?.HasTable) {
            return res.json({ success: true, data: [] });
        }

        const colReq = pool.request();
        const colRes = await colReq.query(`
            SELECT CASE WHEN COL_LENGTH('oe.MemberEventLog', 'EventDetails') IS NOT NULL THEN 1 ELSE 0 END AS HasEventDetails
        `);
        const hasEventDetails = colRes.recordset?.[0]?.HasEventDetails === 1;

        const hres = await hreq.query(`
            SELECT
                e.EventId,
                e.MemberId,
                e.EventType,
                e.OldGroupId,
                e.NewGroupId,
                e.OldGroupName,
                e.NewGroupName,
                ${hasEventDetails ? 'e.EventDetails,' : 'CAST(NULL AS NVARCHAR(MAX)) AS EventDetails,'}
                e.CreatedDate,
                e.CreatedBy,
                LTRIM(RTRIM(ISNULL(u.FirstName, '') + ' ' + ISNULL(u.LastName, ''))) AS CreatedByName
            FROM oe.MemberEventLog e
            LEFT JOIN oe.Users u ON e.CreatedBy = u.UserId
            WHERE e.MemberId = @memberId
            ORDER BY e.CreatedDate DESC
        `);

        res.json({ success: true, data: hres.recordset || [] });
    } catch (error) {
        console.error('❌ Error fetching member history:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch member history' });
    }
});

// GET preview for household-aware removal (inactive + removed_* emails except @noemail.com)
router.get(
    '/:id/household-removal-preview',
    authorize(['Admin', 'SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner']),
    async (req, res) => {
        try {
            const { id } = req.params;
            const guidRegex = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
            if (!id || !guidRegex.test(id)) {
                return res.status(400).json({ success: false, message: 'Invalid member ID format' });
            }
            const pool = await getPool();
            const result = await HouseholdMemberRemovalService.getHouseholdRemovalPreview(pool, req, id);
            if (result.error) {
                return res.status(result.error.status).json({ success: false, message: result.error.message });
            }
            res.json({ success: true, data: result.data });
        } catch (error) {
            console.error('❌ Error household-removal-preview:', error);
            res.status(500).json({ success: false, message: 'Failed to build removal preview' });
        }
    }
);

/**
 * GET /api/members/:memberId/ssn
 * Full 9-digit SSN for authorized staff editing a member (not sent on list/detail GET).
 */
router.get(
  '/:memberId/ssn',
  authorize(['Admin', 'SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']),
  async (req, res) => {
    try {
      const { memberId } = req.params;
      const guidRegex = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
      if (!memberId || !guidRegex.test(memberId)) {
        return res.status(400).json({ success: false, message: 'Invalid member ID format' });
      }

      const pool = await getPool();
      const request = pool.request();
      request.input('memberId', sql.UniqueIdentifier, memberId);

      let query = `
        SELECT m.SSN
        FROM oe.Members m
        JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
        WHERE m.MemberId = @memberId
      `;

      if (!getUserRoles(req.user).includes('SysAdmin')) {
        query += ' AND (g.TenantId = @tenantId OR (g.GroupId IS NULL AND u.TenantId = @tenantId))';
        request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
      }

      const result = await request.query(query);
      if (result.recordset.length === 0) {
        return res.status(404).json({ success: false, message: 'Member not found or access denied' });
      }

      const digits = getSSNDigitsPlain(result.recordset[0].SSN);
      res.json({
        success: true,
        data: { ssn: digits }
      });
    } catch (error) {
      console.error('❌ Error fetching member SSN:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch SSN' });
    }
  }
);

// GET Member by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate GUID format before using in query
        const guidRegex = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
        if (!id || !guidRegex.test(id)) {
            console.error('❌ Invalid MemberId format in GET /api/members/:id:', id);
            return res.status(400).json({
                success: false,
                message: 'Invalid member ID format',
                error: {
                    code: 'INVALID_GUID',
                    message: 'Member ID must be a valid GUID'
                }
            });
        }
        
        const pool = await getPool();
        
        let query = `
            SELECT 
                m.MemberId, m.UserId, m.GroupId, m.HouseholdId, m.MemberSequence,
                m.RelationshipType, m.Status, m.CreatedDate, m.IsPendingMigration, 
                FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                FORMAT(m.HireDate, 'yyyy-MM-dd') as HireDate,
                m.Gender, m.Address, m.City, m.State, m.Zip,
                m.WorkLocation, m.LocationId, m.JobPosition, m.Tier, m.TobaccoUse,
                m.SSN,
                u.FirstName, u.LastName, u.Email, u.PhoneNumber,
                CASE WHEN g.GroupId IS NOT NULL THEN 'LB' ELSE 'SB' END as BillType,
                g.Name as GroupName,
                g.LogoUrl as GroupLogoUrl,
                CASE m.RelationshipType
                    WHEN 'P' THEN 'Primary'
                    WHEN 'S' THEN 'Spouse'
                    WHEN 'C' THEN 'Child'
                    ELSE 'Unknown'
                END as RelationshipDescription,
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
            LEFT JOIN oe.Agents a ON m.AgentId = a.AgentId
            LEFT JOIN oe.Users ag ON a.UserId = ag.UserId
            LEFT JOIN oe.Agents ga ON g.AgentId = ga.AgentId
            LEFT JOIN oe.Users gag ON ga.UserId = gag.UserId
            WHERE m.MemberId = @memberId
        `;
        
        const request = pool.request();
        request.input('memberId', sql.UniqueIdentifier, id);
        
        // Add tenant filtering for non-admin users
        if (!getUserRoles(req.user).includes('SysAdmin')) {
            query += ' AND (g.TenantId = @tenantId OR (g.GroupId IS NULL AND u.TenantId = @tenantId))';
            request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        const result = await request.query(query);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found or access denied'
            });
        }
        
        const memberRow = result.recordset[0];
        // Never send full SSN to frontend; send only last 4 for display
        memberRow.SSNLast4 = getSSNLast4(memberRow.SSN) || null;
        delete memberRow.SSN;
        res.json({ success: true, data: memberRow });
        
    } catch (error) {
        console.error('❌ Error fetching member:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch member' });
    }
});

// POST Members
router.post('/', authorize(['Admin','SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), async (req, res) => {
    try {
        let {
            firstName,
            lastName,
            email,
            phone,
            dateOfBirth,
            gender,
            address,
            city,
            state,
            zip,
            ssn,
            tobaccoUse,
            workLocation,
            locationId,  // LocationId from GroupLocations table
            jobPosition,  // Job position ID (e.g., 'executive', 'manager', etc.)
            groupId,
            relationshipType: relationshipTypeRaw,
            householdId,
            primaryMemberId,  // Frontend sends this when adding a dependent
            hireDate,  // Add hireDate extraction
            confirmExistingUser = false  // NEW: Frontend sends this when user confirms linking existing user
        } = req.body;

        // Default param does not apply when client sends null — normalize so DB never gets NULL RelationshipType
        let relationshipType =
            relationshipTypeRaw == null || String(relationshipTypeRaw).trim() === ''
                ? 'P'
                : String(relationshipTypeRaw).trim().toUpperCase();
        if (relationshipType === 'PRIMARY') relationshipType = 'P';
        if (relationshipType === 'SPOUSE') relationshipType = 'S';
        if (relationshipType === 'CHILD' || relationshipType === 'DEPENDENT') relationshipType = 'C';
        const allowedRelationship = new Set(['P', 'S', 'C']);
        if (!allowedRelationship.has(relationshipType)) {
            return res.status(400).json({
                success: false,
                message: 'relationshipType must be P (primary), S (spouse), or C (child)'
            });
        }

        // Validation
        // Email is required ONLY for primary members - dependents (spouses and children) will have default emails generated
        const emailRequired = relationshipType === 'P';
        if (!firstName || !lastName || (emailRequired && !email)) {
            return res.status(400).json({
                success: false,
                message: emailRequired
                    ? 'First name, last name, and email are required'
                    : 'First name and last name are required (email will be generated for dependents)'
            });
        }

        // Normalize member data so downstream UIs (enrollment wizard, member portal) don't
        // break on ZIP+4 or legacy TobaccoUse='U'. Only validate FORMAT when a value is
        // provided — the Add Member modal lets agents create a minimal name+email shell
        // and fill in SSN/ZIP/etc. later during enrollment. SSN enforcement happens at
        // the wizard/complete-enrollment layer.
        // Rules live in backend/utils/memberDataValidation.js.
        const memberDataValidation = require('../utils/memberDataValidation');
        if (zip != null && String(zip).trim() !== '') {
            const normalizedZip = memberDataValidation.normalizeZip(zip);
            if (!normalizedZip) {
                return res.status(400).json({
                    success: false,
                    message: 'ZIP Code must be 5 digits or 9 digits (ZIP+4).'
                });
            }
            zip = normalizedZip;
        }
        if (ssn != null && String(ssn).trim() !== '') {
            const normalizedSsn = memberDataValidation.normalizeSSN(ssn);
            if (!normalizedSsn) {
                return res.status(400).json({
                    success: false,
                    message: 'Social Security Number must be 9 digits.'
                });
            }
            ssn = normalizedSsn;
        }
        if (tobaccoUse !== undefined) {
            tobaccoUse = memberDataValidation.normalizeTobaccoUse(tobaccoUse);
        }
        if (address != null && String(address).trim() !== '') {
            const { address: normalizedAddress, error: addressError } = memberDataValidation.normalizeStreetAddress(
                address,
                { city, state, zip, phone }
            );
            if (addressError) {
                return res.status(400).json({
                    success: false,
                    message: `${addressError.field}: ${addressError.reason}`,
                });
            }
            address = normalizedAddress;
        }

        // For dependents, primaryMemberId is required
        if (relationshipType !== 'P' && !primaryMemberId && !householdId) {
            return res.status(400).json({
                success: false,
                message: 'Primary member ID is required when adding dependents'
            });
        }
        
        const pool = await getPool();
        const transaction = pool.transaction();
        await transaction.begin();

        try {
            let userId = require('crypto').randomUUID(); // Changed to 'let' so we can reassign for existing users
            const memberId = require('crypto').randomUUID();
            let linkedExistingUser = false; // Track if we linked an existing user
            let finalHouseholdId;
            let memberSequence = 1;
            let tenantId = req.user.TenantId;
            
            // Generate default email for dependents (children and spouses) if not provided (before email check)
            if ((relationshipType === 'C' || relationshipType === 'S') && (!email || email.trim() === '')) {
                email = `dependent-${userId}@noemail.com`;
                console.log(`📧 Generated default email for ${relationshipType === 'C' ? 'child' : 'spouse'}: ${email}`);
            }

            // If adding a dependent, get household info from primary member
            if (relationshipType !== 'P' && primaryMemberId) {
                const primaryRequest = transaction.request();
                primaryRequest.input('primaryMemberId', sql.UniqueIdentifier, primaryMemberId);
                
                const primaryResult = await primaryRequest.query(`
                    SELECT m.HouseholdId, m.TenantId, m.GroupId
                    FROM oe.Members m
                    WHERE m.MemberId = @primaryMemberId
                      AND (m.RelationshipType = 'P' OR m.RelationshipType IS NULL)
                `);

                if (primaryResult.recordset.length === 0) {
                    await transaction.rollback();
                    return res.status(400).json({
                        success: false,
                        message: 'Primary member not found or invalid'
                    });
                }

                // Use the primary member's household and tenant info
                finalHouseholdId = primaryResult.recordset[0].HouseholdId;
                tenantId = primaryResult.recordset[0].TenantId;
                
                // If no groupId provided, use primary member's groupId
                if (!groupId && primaryResult.recordset[0].GroupId) {
                    groupId = primaryResult.recordset[0].GroupId;
                }

                // Get next sequence number for the household
                const seqRequest = transaction.request();
                seqRequest.input('householdId', sql.UniqueIdentifier, finalHouseholdId);
                const seqResult = await seqRequest.query(`
                    SELECT ISNULL(MAX(MemberSequence), 0) + 1 as NextSequence 
                    FROM oe.Members 
                    WHERE HouseholdId = @householdId
                `);
                memberSequence = seqResult.recordset[0].NextSequence;
                
            } else {
                // For primary members, create new household or use provided one
                finalHouseholdId = householdId || require('crypto').randomUUID();
                
                // If groupId provided, get tenant from group
                if (groupId) {
                    const groupRequest = transaction.request();
                    groupRequest.input('groupId', sql.UniqueIdentifier, groupId);
                    const groupResult = await groupRequest.query('SELECT TenantId FROM oe.Groups WHERE GroupId = @groupId');
                    if (groupResult.recordset.length > 0) {
                        tenantId = groupResult.recordset[0].TenantId;
                    }
                }
            }

            // Check if email already exists (skip for generated dependent emails)
            let emailCheckResult = { recordset: [] };
            if (email && !email.includes('@noemail.com')) {
                const emailCheckRequest = transaction.request();
                emailCheckRequest.input('email', sql.NVarChar, email);
                emailCheckResult = await emailCheckRequest.query(`
                    SELECT u.UserId, u.FirstName, u.LastName, u.PhoneNumber, u.Email,
                           m.MemberId, m.GroupId, m.HouseholdId, m.RelationshipType,
                           m.Address, m.City, m.State, m.Zip,
                           STRING_AGG(r.Name, ', ') as Roles
                    FROM oe.Users u
                    LEFT JOIN oe.Members m ON u.UserId = m.UserId
                    LEFT JOIN oe.UserRoles ur ON u.UserId = ur.UserId
                    LEFT JOIN oe.Roles r ON ur.RoleId = r.RoleId
                    WHERE u.Email = @email
                    GROUP BY u.UserId, u.FirstName, u.LastName, u.PhoneNumber, u.Email,
                             m.MemberId, m.GroupId, m.HouseholdId, m.RelationshipType,
                             m.Address, m.City, m.State, m.Zip
                `);
            } else if (email && email.includes('@noemail.com')) {
                console.log(`📧 Skipping email check for generated dependent email: ${email}`);
            }
            
            if (emailCheckResult.recordset.length > 0) {
                // User with this email exists - check they are not already a member in this group (or optionally in any group)
                const existingUser = emailCheckResult.recordset[0];
                userId = existingUser.UserId;

                if (groupId) {
                    const alreadyInGroupRequest = transaction.request();
                    alreadyInGroupRequest.input('userId', sql.UniqueIdentifier, userId);
                    alreadyInGroupRequest.input('groupId', sql.UniqueIdentifier, groupId);
                    const alreadyInGroupResult = await alreadyInGroupRequest.query(`
                        SELECT m.MemberId, m.GroupId, g.Name AS GroupName
                        FROM oe.Members m
                        LEFT JOIN oe.Groups g ON g.GroupId = m.GroupId
                        WHERE m.UserId = @userId AND m.GroupId = @groupId
                    `);
                    if (alreadyInGroupResult.recordset.length > 0) {
                        await transaction.rollback();
                        const row = alreadyInGroupResult.recordset[0];
                        const groupNameSuffix = row.GroupName ? ` (${row.GroupName})` : '';
                        return res.status(400).json({
                            success: false,
                            message: `This email is already a member in this group${groupNameSuffix}.`,
                            data: { existingInGroup: true, groupId, groupName: row.GroupName || null }
                        });
                    }
                    // Optional: tell them if already a member of another group (for context)
                    const otherGroupRequest = transaction.request();
                    otherGroupRequest.input('userId', sql.UniqueIdentifier, userId);
                    otherGroupRequest.input('groupId', sql.UniqueIdentifier, groupId);
                    const otherGroupResult = await otherGroupRequest.query(`
                        SELECT TOP 1 m.GroupId, g.Name AS GroupName
                        FROM oe.Members m
                        LEFT JOIN oe.Groups g ON g.GroupId = m.GroupId
                        WHERE m.UserId = @userId AND m.GroupId != @groupId AND m.Status = 'Active'
                    `);
                    const otherGroup = otherGroupResult.recordset[0];
                    if (otherGroup) {
                        await transaction.rollback();
                        const groupName = otherGroup.GroupName ? ` (${otherGroup.GroupName})` : '';
                        return res.status(400).json({
                            success: false,
                            message: `This email is already a member in our system${groupName}. They cannot be added to another group.`,
                            data: { existingInOtherGroup: true, groupId: otherGroup.GroupId, groupName: otherGroup.GroupName || null }
                        });
                    }
                }

                console.log(`✅ Automatically linking existing user to new member: ${existingUser.FirstName} ${existingUser.LastName} (${existingUser.Roles || 'User'})`);
                linkedExistingUser = true; // Mark that we linked an existing user

                // Form data takes precedence - use form data if provided (non-empty), otherwise fall back to existing user data
                // This allows admins to update/correct information when adding existing users as members
                firstName = (firstName && firstName.trim()) ? firstName.trim() : existingUser.FirstName;
                lastName = (lastName && lastName.trim()) ? lastName.trim() : existingUser.LastName;
                email = existingUser.Email; // Always use existing email (can't change email)
                phone = (phone && phone.trim()) ? phone.trim() : existingUser.PhoneNumber; // Use form phone if provided, fallback to existing
                // Address fields: use form data if provided (non-empty), otherwise use existing
                address = (address && address.trim()) ? address.trim() : existingUser.Address;
                city = (city && city.trim()) ? city.trim() : existingUser.City;
                state = (state && state.trim()) ? state.trim() : existingUser.State;
                zip = (zip && zip.trim()) ? zip.trim() : existingUser.Zip;
                
                console.log(`📝 Using form data (with fallback to existing): ${firstName} ${lastName}, Phone: ${phone}`);
                
                // Skip user creation - user already exists
                // Continue to member creation below
            } else {
                // No existing user - create new user record
                const userRequest = transaction.request();
                userRequest.input('userId', sql.UniqueIdentifier, userId);
                userRequest.input('firstName', sql.NVarChar, firstName);
                userRequest.input('lastName', sql.NVarChar, lastName);
                userRequest.input('email', sql.NVarChar, email);
                userRequest.input('phoneNumber', sql.NVarChar, phone || null);
                userRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
                userRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);

                await userRequest.query(`
                    INSERT INTO oe.Users 
                    (UserId, FirstName, LastName, Email, PhoneNumber, TenantId, Status, 
                     CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                    VALUES 
                    (@userId, @firstName, @lastName, @email, @phoneNumber, @tenantId, 'Pending',
                     GETDATE(), GETDATE(), @createdBy, @createdBy)
                `);
                
                console.log(`✅ Created new user: ${firstName} ${lastName}`);
            }

            // Determine AgentId with priority: frontend-specified > user's own agent > creator agent
            let agentId = req.body.agentId || null; // Allow frontend to specify agent

            // If frontend passed an AgencyId instead of AgentId, resolve to the agency owner agent.
            // This prevents FK_Members_AgentId failures when UI dropdown includes agencies.
            if (agentId) {
                const providedAgentRequest = transaction.request();
                providedAgentRequest.input('providedId', sql.UniqueIdentifier, agentId);
                const providedAgentResult = await providedAgentRequest.query(`
                    SELECT TOP 1 AgentId
                    FROM oe.Agents
                    WHERE AgentId = @providedId
                `);

                if (providedAgentResult.recordset.length === 0) {
                    const agencyOwnerRequest = transaction.request();
                    agencyOwnerRequest.input('agencyId', sql.UniqueIdentifier, agentId);
                    const agencyOwnerResult = await agencyOwnerRequest.query(`
                        SELECT TOP 1 aa.AgentId AS OwnerAgentId
                        FROM oe.AgencyAdmins aa
                        WHERE aa.AgencyId = @agencyId AND aa.Status = 'Active'
                        ORDER BY aa.AgentId
                    `);

                    const resolvedOwnerAgentId = agencyOwnerResult.recordset[0]?.OwnerAgentId || null;
                    if (resolvedOwnerAgentId) {
                        agentId = resolvedOwnerAgentId;
                        console.log('🏢 Resolved provided AgencyId to OwnerAgentId for member assignment:', agentId);
                    } else {
                        console.warn('⚠️ Provided agentId was not an AgentId and could not be resolved to an agency owner; falling back to automatic assignment.');
                        agentId = null;
                    }
                }
            }
            
            // If no agent specified, check if the USER BEING ADDED is an agent themselves
            if (!agentId && linkedExistingUser) {
                const userAgentCheckRequest = transaction.request();
                userAgentCheckRequest.input('userId', sql.UniqueIdentifier, userId);
                const userAgentCheckResult = await userAgentCheckRequest.query(`
                    SELECT AgentId FROM oe.Agents WHERE UserId = @userId
                `);
                if (userAgentCheckResult.recordset.length > 0) {
                    agentId = userAgentCheckResult.recordset[0].AgentId;
                    console.log('🧑‍💼 User being added is an agent - assigning to themselves:', agentId);
                }
            }
            
            // If still no agent, and creator is an agent, assign to creator
            if (!agentId) {
                const userRoles = getUserRoles(req.user);
                if (userRoles.includes('Agent')) {
                    // Get the creating user's AgentId from oe.Agents
                    const creatorAgentRequest = transaction.request();
                    creatorAgentRequest.input('creatorUserId', sql.UniqueIdentifier, req.user.UserId);
                    const creatorAgentResult = await creatorAgentRequest.query(`
                        SELECT AgentId FROM oe.Agents WHERE UserId = @creatorUserId
                    `);
                    if (creatorAgentResult.recordset.length > 0) {
                        agentId = creatorAgentResult.recordset[0].AgentId;
                        console.log('🧑‍💼 Assigning member to creator agent:', agentId);
                    }
                }
            }
            
            console.log(`🔍 Final AgentId assignment: ${agentId || 'None'}`);

            const postRoles = getUserRoles(req.user);
            const postPrivileged =
                postRoles.includes('SysAdmin') || postRoles.includes('TenantAdmin') || postRoles.includes('Admin');
            const explicitAgentIdFromRequest =
                req.body.agentId != null && String(req.body.agentId).trim() !== '';
            const postAgentLike = postRoles.includes('Agent') || postRoles.includes('AgencyOwner');
            if (agentId && !postPrivileged && postAgentLike && explicitAgentIdFromRequest) {
                const { assertAgentMayAssignToTargetAgent } = require('../utils/agentAssignable');
                const errAssign = await assertAgentMayAssignToTargetAgent(pool, req.user.UserId, agentId, {});
                if (errAssign) {
                    await transaction.rollback();
                    return res.status(403).json({ success: false, message: errAssign });
                }
            }

            // Create Member record
            const memberRequest = transaction.request();
            memberRequest.input('memberId', sql.UniqueIdentifier, memberId);
            memberRequest.input('userId', sql.UniqueIdentifier, userId);
            memberRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
            memberRequest.input('groupId', sql.UniqueIdentifier, groupId || null);
            memberRequest.input('agentId', sql.UniqueIdentifier, agentId);
            memberRequest.input('householdId', sql.UniqueIdentifier, finalHouseholdId);
            memberRequest.input('memberSequence', sql.Int, memberSequence);
            memberRequest.input('relationshipType', sql.NVarChar, relationshipType);
            memberRequest.input('dateOfBirth', sql.Date, dateOfBirth || null);
            memberRequest.input('gender', sql.NVarChar, gender || null);
            memberRequest.input('address', sql.NVarChar, address || null);
            memberRequest.input('city', sql.NVarChar, city || null);
            memberRequest.input('state', sql.NVarChar, state || null);
            memberRequest.input('zip', sql.NVarChar, zip || null);
            memberRequest.input('ssn', sql.NVarChar, ssn || null);
            memberRequest.input('workLocation', sql.NVarChar, workLocation || null);
            memberRequest.input('locationId', sql.UniqueIdentifier, locationId || null);
            memberRequest.input('jobPosition', sql.NVarChar(50), jobPosition || null);
            memberRequest.input('hireDate', sql.Date, hireDate || null);
            memberRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);

            await memberRequest.query(`
                INSERT INTO oe.Members 
                (MemberId, UserId, TenantId, GroupId, AgentId, HouseholdId, MemberSequence, 
                 RelationshipType, Status, DateOfBirth, Gender, Address, City, State, Zip, SSN,
                 WorkLocation, LocationId, JobPosition, HireDate, EnrollmentType, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                VALUES 
                (@memberId, @userId, @tenantId, @groupId, @agentId, @householdId, @memberSequence,
                 @relationshipType, 'Active', @dateOfBirth, @gender, @address, @city, @state, @zip, @ssn,
                 @workLocation, @locationId, @jobPosition, @hireDate, 'Standard', GETDATE(), GETDATE(), @createdBy, @createdBy)
            `);

            // Generate HouseholdMemberID using the stored procedure
            const householdMemberIdRequest = transaction.request();
            householdMemberIdRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
            householdMemberIdRequest.input('MemberId', sql.UniqueIdentifier, memberId);
            householdMemberIdRequest.output('HouseholdMemberID', sql.NVarChar(50));
            
            await householdMemberIdRequest.execute('oe.GenerateHouseholdMemberID');
            const generatedHouseholdMemberID = householdMemberIdRequest.parameters.HouseholdMemberID.value;
            
            // Update the member with the generated HouseholdMemberID
            const updateHouseholdIdRequest = transaction.request();
            updateHouseholdIdRequest.input('memberId', sql.UniqueIdentifier, memberId);
            updateHouseholdIdRequest.input('householdMemberID', sql.NVarChar(50), generatedHouseholdMemberID);
            
            await updateHouseholdIdRequest.query(`
                UPDATE oe.Members 
                SET HouseholdMemberID = @householdMemberID, ModifiedDate = GETDATE()
                WHERE MemberId = @memberId
            `);

            // Member portal auth uses oe.UserRoles — same transaction as member insert so we never commit without role
            await UserRolesService.assignRoleToUser(userId, 'Member', req.user.UserId, transaction);

            await transaction.commit();

            const messageType = relationshipType === 'P' ? 'Member and household' : 'Dependent';
            const successMessage = linkedExistingUser 
                ? `${messageType} created successfully (linked to existing user account)`
                : `${messageType} created successfully`;
            
            res.status(201).json({
                success: true,
                message: successMessage,
                data: {
                    memberId,
                    userId,
                    householdId: finalHouseholdId,
                    memberSequence,
                    relationshipType,
                    householdMemberID: generatedHouseholdMemberID,
                    linkedExistingUser: linkedExistingUser // NEW: Indicate if existing user was linked
                }
            });

            console.log(`✅ ${messageType} created: ${firstName} ${lastName} (${memberId})${linkedExistingUser ? ' - Linked to existing user' : ''}`);

            // Update setup status if member was added to a group
            if (groupId) {
                try {
                    const { updateSetupStatus } = require('../services/setupStatus.service');
                    await updateSetupStatus(groupId);
                    console.log(`✅ Updated setup status for group ${groupId} after adding member ${memberId}`);
                } catch (error) {
                    console.warn('⚠️ Failed to update setup status:', error.message);
                }
            }

        } catch (error) {
            await transaction.rollback();
            throw error;
        }

    } catch (error) {
        console.error('❌ Error creating member:', error);
        // Check for duplicate member (UserId + GroupId already exists in oe.Members)
        const errMsg = error?.message || '';
        const errNum = error?.number ?? error?.originalError?.info?.number;
        const isDuplicateMember = errNum === 2627 || errNum === 2601 ||
            errMsg.includes('UNIQUE') || errMsg.includes('duplicate') || errMsg.includes('unique constraint');
        if (isDuplicateMember) {
            return res.status(200).json({
                success: true,
                message: 'Member already exists in this group',
                data: { alreadyExists: true, existingInGroup: true }
            });
        }
        res.status(500).json({
            success: false,
            message: 'Failed to create member'
        });
    }
});

// PUT Members - Update member (FIXED FOR EDIT ONLY)
router.put('/:id', (req, res, next) => {
    console.log('🔍 PUT /api/members/:id - Route handler called');
    console.log('📋 Request params:', req.params);
    console.log('📋 Request body:', req.body);
    next();
}, authorize(['Admin', 'SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = req.body;

        // Normalize member data so downstream UIs don't break on ZIP+4, legacy
        // TobaccoUse='U', or malformed SSN. Same rules the wizard enforces.
        // Rules live in backend/utils/memberDataValidation.js.
        const memberDataValidation = require('../utils/memberDataValidation');
        if (updateData.zip != null && String(updateData.zip).trim() !== '') {
            const normalizedZip = memberDataValidation.normalizeZip(updateData.zip);
            if (!normalizedZip) {
                return res.status(400).json({
                    success: false,
                    message: 'ZIP Code must be 5 digits or 9 digits (ZIP+4).'
                });
            }
            updateData.zip = normalizedZip;
        }
        if (updateData.ssn != null && String(updateData.ssn).trim() !== '') {
            const normalizedSsn = memberDataValidation.normalizeSSN(updateData.ssn);
            if (!normalizedSsn) {
                return res.status(400).json({
                    success: false,
                    message: 'Social Security Number must be 9 digits.'
                });
            }
            updateData.ssn = normalizedSsn;
        }
        if (updateData.tobaccoUse !== undefined) {
            updateData.tobaccoUse = memberDataValidation.normalizeTobaccoUse(updateData.tobaccoUse);
        }
        if (updateData.address != null && String(updateData.address).trim() !== '') {
            const phoneForAddress = updateData.phoneNumber ?? updateData.phone;
            const { address: normalizedAddress, error: addressError } = memberDataValidation.normalizeStreetAddress(
                updateData.address,
                {
                    city: updateData.city,
                    state: updateData.state,
                    zip: updateData.zip,
                    phone: phoneForAddress,
                }
            );
            if (addressError) {
                return res.status(400).json({
                    success: false,
                    message: `${addressError.field}: ${addressError.reason}`,
                });
            }
            updateData.address = normalizedAddress;
        }

        const requestedEmail =
            typeof updateData.email === 'string' && updateData.email.trim() !== ''
                ? updateData.email.trim()
                : null;
        updateData.email = undefined;

        console.log('🔍 PUT /api/members/:id - Update request received');
        console.log('👤 User:', { 
            userId: req.user?.UserId,
            email: req.user?.Email
        });
        console.log('📋 Member ID:', id);
        console.log('📋 Update data:', updateData);

        const pool = await getPool();
        const userRoles = getUserRoles(req.user);

        const preReq = pool.request();
        preReq.input('memberId', sql.UniqueIdentifier, id);
        const preRes = await preReq.query(`
            SELECT
                m.UserId,
                m.RelationshipType,
                m.TenantId,
                m.AgentId,
                m.GroupId,
                m.HouseholdId,
                u.TenantId AS UserTenantId,
                g.TenantId AS GroupTenantId,
                COALESCE(m.TenantId, g.TenantId, u.TenantId) AS EffectiveTenantId
            FROM oe.Members m
            INNER JOIN oe.Users u ON u.UserId = m.UserId
            LEFT JOIN oe.Groups g ON g.GroupId = m.GroupId
            WHERE m.MemberId = @memberId
        `);
        if (preRes.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }
        const mctx = preRes.recordset[0];
        const effectiveTenantId = mctx.EffectiveTenantId || mctx.TenantId || mctx.UserTenantId || null;

        // Dependent (spouse/child) email: persist to oe.Users via shared service (primary still uses Change Email modal only)
        if (requestedEmail && (mctx.RelationshipType === 'S' || mctx.RelationshipType === 'C')) {
            let authorized = userRoles.includes('SysAdmin') || userRoles.includes('Admin');
            if (!authorized && userRoles.includes('TenantAdmin')) {
                const tid = req.tenantId || req.user.TenantId;
                if (tid && effectiveTenantId && String(effectiveTenantId).toLowerCase() === String(tid).toLowerCase()) {
                    authorized = true;
                }
            }
            if (!authorized && userRoles.includes('Agent')) {
                const ar = await pool.request();
                ar.input('userId', sql.UniqueIdentifier, req.user.UserId);
                const ag = await ar.query('SELECT AgentId FROM oe.Agents WHERE UserId = @userId');
                const aid = ag.recordset[0]?.AgentId;
                if (aid && mctx.AgentId && String(mctx.AgentId).toLowerCase() === String(aid).toLowerCase()) {
                    authorized = true;
                }
            }
            if (!authorized && userRoles.includes('GroupAdmin') && req.user.currentRole === 'GroupAdmin' && mctx.GroupId) {
                const gar = await pool.request();
                gar.input('userId', sql.UniqueIdentifier, req.user.UserId);
                gar.input('groupId', sql.UniqueIdentifier, mctx.GroupId);
                const gchk = await gar.query(`
                    SELECT 1 FROM oe.GroupAdmins
                    WHERE UserId = @userId AND GroupId = @groupId AND Status = 'Active'
                `);
                if (gchk.recordset.length > 0) authorized = true;
            }
            if (!authorized) {
                return res.status(403).json({ success: false, message: 'Not authorized to change this member email' });
            }
            const emailResult = await UserEmailService.updateUserEmail(mctx.UserId, requestedEmail, req.user.UserId);
            if (!emailResult.success) {
                return res.status(400).json({ success: false, message: emailResult.message || 'Failed to update email' });
            }
        }

        let pendingGroupChange = null;
        if (updateData.groupId !== undefined) {
            const userRoles = getUserRoles(req.user);
            if (!userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
                return res.status(403).json({ success: false, message: 'Not authorized to change member group' });
            }
            if (userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
                const tid = req.tenantId || req.user.TenantId;
                if (!tid || !effectiveTenantId || String(effectiveTenantId).toLowerCase() !== String(tid).toLowerCase()) {
                    return res.status(403).json({ success: false, message: 'Not authorized to change member group' });
                }
            }

            let newGroupId = null;
            const rawG = updateData.groupId;
            if (rawG !== null && rawG !== undefined && String(rawG).trim() !== '' && String(rawG) !== '__NO_GROUP__') {
                newGroupId = String(rawG).trim();
            }
            const guidRegex = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
            if (newGroupId !== null && !guidRegex.test(newGroupId)) {
                return res.status(400).json({ success: false, message: 'Invalid group id' });
            }

            const oldGroupId = mctx.GroupId || null;
            const normG = (g) => (g ? String(g).toLowerCase() : '');
            if (normG(newGroupId) !== normG(oldGroupId)) {
                if (newGroupId === null) {
                    const blockReq = pool.request();
                    blockReq.input('memberId', sql.UniqueIdentifier, id);
                    const blockRes = await blockReq.query(`
                        SELECT COUNT(*) AS cnt FROM oe.Enrollments e
                        WHERE e.MemberId = @memberId
                        AND e.ProductId IS NOT NULL
                        AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                        AND (
                            (e.Status = 'Active' AND (e.TerminationDate IS NULL OR e.TerminationDate > GETDATE()))
                            OR (e.Status = 'Pending' AND (e.TerminationDate IS NULL OR e.TerminationDate > GETDATE()))
                            OR (e.Status = N'PaymentHold' AND (e.TerminationDate IS NULL OR e.TerminationDate > GETDATE()))
                        )
                    `);
                    const cnt = blockRes.recordset[0]?.cnt ?? 0;
                    if (cnt > 0) {
                        return res.status(400).json({
                            success: false,
                            message: 'Cannot remove group membership while the member has active product enrollments. Terminate or end those enrollments first.',
                            error: { code: 'GROUP_REMOVE_BLOCKED_ACTIVE_ENROLLMENTS' }
                        });
                    }
                    let oldGroupName = null;
                    if (oldGroupId) {
                        const onReq = pool.request();
                        onReq.input('gid', sql.UniqueIdentifier, oldGroupId);
                        const onRes = await onReq.query('SELECT Name FROM oe.Groups WHERE GroupId = @gid');
                        if (onRes.recordset.length > 0) oldGroupName = onRes.recordset[0].Name;
                    }
                    pendingGroupChange = {
                        newGroupId: null,
                        oldGroupId,
                        oldGroupName,
                        newGroupName: null,
                        newAgentId: null,
                        clearGroup: true
                    };
                } else {
                    const gReq = pool.request();
                    gReq.input('gId', sql.UniqueIdentifier, newGroupId);
                    const gRes = await gReq.query(`SELECT GroupId, TenantId, Name, AgentId FROM oe.Groups WHERE GroupId = @gId`);
                    if (gRes.recordset.length === 0) {
                        return res.status(400).json({ success: false, message: 'Selected group was not found' });
                    }
                    const gRow = gRes.recordset[0];
                    if (!effectiveTenantId || String(gRow.TenantId).toLowerCase() !== String(effectiveTenantId).toLowerCase()) {
                        return res.status(400).json({ success: false, message: 'Group must belong to the same tenant as the member' });
                    }
                    let oldGroupName = null;
                    if (oldGroupId) {
                        const onReq = pool.request();
                        onReq.input('gid', sql.UniqueIdentifier, oldGroupId);
                        const onRes = await onReq.query('SELECT Name FROM oe.Groups WHERE GroupId = @gid');
                        if (onRes.recordset.length > 0) oldGroupName = onRes.recordset[0].Name;
                    }
                    pendingGroupChange = {
                        newGroupId,
                        oldGroupId,
                        oldGroupName,
                        newGroupName: gRow.Name || null,
                        newAgentId: gRow.AgentId || null,
                        clearGroup: false
                    };
                }
            }
            delete updateData.groupId;
        }

        if (pendingGroupChange) {
            updateData.locationId = undefined;
            updateData.workLocation = undefined;
            if (pendingGroupChange.clearGroup) {
                updateData.hireDate = undefined;
            }
            if (!pendingGroupChange.clearGroup) {
                updateData.agentId = undefined;
            }
        }

        const requestedCascadeAgentId = pendingGroupChange && !pendingGroupChange.clearGroup
            ? (pendingGroupChange.newAgentId || null)
            : (updateData.agentId !== undefined ? (updateData.agentId || null) : undefined);

        if (updateData.agentId !== undefined) {
            const putRoles = getUserRoles(req.user);
            const putPrivileged =
                putRoles.includes('SysAdmin') || putRoles.includes('TenantAdmin') || putRoles.includes('Admin');
            const putAgentLike = putRoles.includes('Agent') || putRoles.includes('AgencyOwner');
            if (!putPrivileged && putAgentLike) {
                if (mctx.GroupId) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Cannot change agent for group members. Group members must be assigned to the group's agent.",
                        error: {
                            code: 'GROUP_MEMBER_AGENT_LOCKED',
                            message: 'Agent assignment is locked for group members'
                        }
                    });
                }
                const { assertAgentMayAssignToTargetAgent } = require('../utils/agentAssignable');
                const errAssign = await assertAgentMayAssignToTargetAgent(pool, req.user.UserId, updateData.agentId, {
                    forMemberId: id
                });
                if (errAssign) {
                    return res.status(403).json({ success: false, message: errAssign });
                }
            }
        }

        const transaction = pool.transaction();
        await transaction.begin();

        try {

            // Update User fields if provided (name/phone are stored on oe.Users; email is never updated here)
            if (updateData.firstName || updateData.lastName || updateData.phone) {
                // Safeguard: do not overwrite identity (firstName, lastName) for users who are agents.
                // Editing a member row would otherwise overwrite the agent's global name (see: Susan Cataldo / Brandon Gratzer).
                const agentCheckRequest = transaction.request();
                agentCheckRequest.input('memberId', sql.UniqueIdentifier, id);
                const agentCheckResult = await agentCheckRequest.query(`
                    SELECT 1 FROM oe.Members m
                    INNER JOIN oe.Agents ag ON ag.UserId = m.UserId
                    WHERE m.MemberId = @memberId
                `);
                const memberIsAgent = agentCheckResult.recordset.length > 0;
                if (memberIsAgent) {
                    // Allow phone update only; do not update FirstName, LastName for agents
                    updateData.firstName = undefined;
                    updateData.lastName = undefined;
                    console.log('⚠️ PUT /api/members/:id - Skipping User name update: member is an agent; only phone may be updated via this endpoint.');
                }

                const userRequest = transaction.request();
                userRequest.input('memberId', sql.UniqueIdentifier, id);
                userRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

                const userFields = [];
                if (updateData.firstName) {
                    userFields.push('FirstName = @firstName');
                    userRequest.input('firstName', sql.NVarChar, updateData.firstName);
                }
                if (updateData.lastName) {
                    userFields.push('LastName = @lastName');
                    userRequest.input('lastName', sql.NVarChar, updateData.lastName);
                }
                if (updateData.phone !== undefined) {
                    userFields.push('PhoneNumber = @phoneNumber');
                    userRequest.input('phoneNumber', sql.NVarChar, updateData.phone || null);
                }

                if (userFields.length > 0) {
                    userFields.push('ModifiedDate = GETDATE()');
                    userFields.push('ModifiedBy = @modifiedBy');

                    await userRequest.query(`
                        UPDATE oe.Users 
                        SET ${userFields.join(', ')}
                        WHERE UserId = (SELECT UserId FROM oe.Members WHERE MemberId = @memberId)
                    `);
                }
            }

            // Update Member fields if provided
            const memberRequest = transaction.request();
            memberRequest.input('memberId', sql.UniqueIdentifier, id);
            memberRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

            const memberFields = [];
            
            if (updateData.dateOfBirth !== undefined) {
                memberFields.push('DateOfBirth = @dateOfBirth');
                memberRequest.input('dateOfBirth', sql.Date, updateData.dateOfBirth || null);
            }
            if (updateData.gender !== undefined) {
                memberFields.push('Gender = @gender');
                memberRequest.input('gender', sql.NVarChar, updateData.gender || null);
            }
            if (updateData.address !== undefined) {
                memberFields.push('Address = @address');
                memberRequest.input('address', sql.NVarChar, updateData.address || null);
            }
            if (updateData.city !== undefined) {
                memberFields.push('City = @city');
                memberRequest.input('city', sql.NVarChar, updateData.city || null);
            }
            if (updateData.state !== undefined) {
                memberFields.push('State = @state');
                memberRequest.input('state', sql.NVarChar, updateData.state || null);
            }
            if (updateData.zip !== undefined) {
                memberFields.push('Zip = @zip');
                memberRequest.input('zip', sql.NVarChar, updateData.zip || null);
            }
            if (updateData.workLocation !== undefined) {
                memberFields.push('WorkLocation = @workLocation');
                memberRequest.input('workLocation', sql.NVarChar, updateData.workLocation || null);
            }
            if (updateData.locationId !== undefined) {
                memberFields.push('LocationId = @locationId');
                memberRequest.input('locationId', sql.UniqueIdentifier, updateData.locationId || null);
            }
            if (updateData.jobPosition !== undefined) {
                memberFields.push('JobPosition = @jobPosition');
                memberRequest.input('jobPosition', sql.NVarChar(50), updateData.jobPosition || null);
            }
            if (updateData.hireDate !== undefined) {
                console.log('🔍 Processing HireDate field:', updateData.hireDate);
                memberFields.push('HireDate = @hireDate');
                memberRequest.input('hireDate', sql.Date, updateData.hireDate || null);
                console.log('✅ HireDate field added to update query');
            }
            if (updateData.agentId !== undefined) {
                console.log('🔍 Processing AgentId field:', updateData.agentId);
                
                // Check if member is part of a group - cannot change agent for group members
                const groupCheckRequest = transaction.request();
                groupCheckRequest.input('checkMemberId', sql.UniqueIdentifier, id);
                const groupCheckResult = await groupCheckRequest.query(`
                    SELECT GroupId FROM oe.Members WHERE MemberId = @checkMemberId
                `);
                
                if (groupCheckResult.recordset.length > 0 && groupCheckResult.recordset[0].GroupId) {
                    console.log('⚠️ Cannot change agent for group member - agent is locked to group agent');
                    await transaction.rollback();
                    return res.status(400).json({
                        success: false,
                        message: 'Cannot change agent for group members. Group members must be assigned to the group\'s agent.',
                        error: {
                            code: 'GROUP_MEMBER_AGENT_LOCKED',
                            message: 'Agent assignment is locked for group members'
                        }
                    });
                }
                
                memberFields.push('AgentId = @agentId');
                memberRequest.input('agentId', sql.UniqueIdentifier, updateData.agentId || null);
                console.log('✅ AgentId field added to update query');
            }
            if (updateData.status !== undefined) {
                memberFields.push('Status = @status');
                memberRequest.input('status', sql.NVarChar, updateData.status);
            }
            if (updateData.terminationDate !== undefined) {
                memberFields.push('TerminationDate = @terminationDate');
                memberRequest.input('terminationDate', sql.Date, updateData.terminationDate || null);
            }
            if (updateData.ssn !== undefined && updateData.ssn !== null && updateData.ssn.trim() !== '') {
                // Validate SSN format (9 digits) and encrypt before storing
                const encryptedSSN = formatAndEncryptSSN(updateData.ssn);
                if (encryptedSSN) {
                    memberFields.push('SSN = @ssn');
                    memberRequest.input('ssn', sql.NVarChar, encryptedSSN);
                }
                // If invalid format, skip update (don't update SSN)
            }
            // Only allow relationship type changes between S and C (not to/from P)
            if (updateData.relationshipType !== undefined) {
                // Get current relationship type first
                const currentTypeRequest = transaction.request();
                currentTypeRequest.input('checkMemberId', sql.UniqueIdentifier, id);
                const currentTypeResult = await currentTypeRequest.query(`
                    SELECT RelationshipType FROM oe.Members WHERE MemberId = @checkMemberId
                `);
                
                if (currentTypeResult.recordset.length > 0) {
                    const currentType = currentTypeResult.recordset[0].RelationshipType;
                    
                    // Only allow changes if:
                    // 1. Current is not 'P' AND new is not 'P' (S <-> C allowed)
                    // 2. OR no change is being made
                    if ((currentType !== 'P' && updateData.relationshipType !== 'P') || 
                        currentType === updateData.relationshipType) {
                        memberFields.push('RelationshipType = @relationshipType');
                        memberRequest.input('relationshipType', sql.NVarChar, updateData.relationshipType);
                    }
                }
            }

            if (pendingGroupChange) {
                memberFields.push('GroupId = @groupIdAssign');
                memberRequest.input('groupIdAssign', sql.UniqueIdentifier, pendingGroupChange.newGroupId || null);
                memberFields.push('LocationId = @locClear');
                memberRequest.input('locClear', sql.UniqueIdentifier, null);
                memberFields.push('WorkLocation = @wlClear');
                memberRequest.input('wlClear', sql.NVarChar, null);
                if (!mctx.TenantId && effectiveTenantId) {
                    memberFields.push('TenantId = @tenantIdBackfill');
                    memberRequest.input('tenantIdBackfill', sql.UniqueIdentifier, effectiveTenantId);
                }
                if (pendingGroupChange.clearGroup) {
                    memberFields.push('HireDate = @hireClear');
                    memberRequest.input('hireClear', sql.Date, null);
                } else {
                    memberFields.push('AgentId = @agentFromGroup');
                    memberRequest.input('agentFromGroup', sql.UniqueIdentifier, pendingGroupChange.newAgentId);
                }
            }

            if (memberFields.length > 0) {
                memberFields.push('ModifiedDate = GETDATE()');
                memberFields.push('ModifiedBy = @modifiedBy');

                console.log('🔍 Updating member fields:', memberFields);
                let query = `
                    UPDATE oe.Members 
                    SET ${memberFields.join(', ')}
                    WHERE MemberId = @memberId
                `;
                console.log('🔍 Update query:', query);

                const result = await memberRequest.query(query);
                console.log('✅ Member fields updated successfully, rows affected:', result.rowsAffected[0]);

                if (result.rowsAffected[0] === 0) {
                    await transaction.rollback();
                    return res.status(404).json({
                        success: false,
                        message: 'Member not found or access denied'
                    });
                }

                if (pendingGroupChange && result.rowsAffected[0] > 0) {
                    try {
                        const logReq = transaction.request();
                        logReq.input('memberId', sql.UniqueIdentifier, id);
                        logReq.input('eventType', sql.NVarChar, 'GROUP_CHANGED');
                        logReq.input('oldGroupId', sql.UniqueIdentifier, pendingGroupChange.oldGroupId || null);
                        logReq.input('newGroupId', sql.UniqueIdentifier, pendingGroupChange.newGroupId || null);
                        logReq.input('oldGroupName', sql.NVarChar, pendingGroupChange.oldGroupName || null);
                        logReq.input('newGroupName', sql.NVarChar, pendingGroupChange.newGroupName || null);
                        logReq.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
                        await logReq.query(`
                            IF OBJECT_ID('oe.MemberEventLog', 'U') IS NOT NULL
                            BEGIN
                                INSERT INTO oe.MemberEventLog (MemberId, EventType, OldGroupId, NewGroupId, OldGroupName, NewGroupName, CreatedBy)
                                VALUES (@memberId, @eventType, @oldGroupId, @newGroupId, @oldGroupName, @newGroupName, @createdBy)
                            END
                        `);
                    } catch (logErr) {
                        console.warn('⚠️ MemberEventLog insert failed:', logErr.message);
                    }

                    if (pendingGroupChange && result.rowsAffected[0] > 0 && mctx.HouseholdId && effectiveTenantId) {
                        try {
                            const tenantPrefixReq = transaction.request();
                            tenantPrefixReq.input('tenantId', sql.UniqueIdentifier, effectiveTenantId);
                            const tenantPrefixRes = await tenantPrefixReq.query(`
                                SELECT MemberIDPrefix, IndividualMemberIDPrefix
                                FROM oe.Tenants
                                WHERE TenantId = @tenantId
                            `);
                            if (tenantPrefixRes.recordset.length > 0) {
                                const tp = tenantPrefixRes.recordset[0];
                                const swap = computePrefixSwapForGroupChange({
                                    clearingGroup: pendingGroupChange.clearGroup,
                                    memberIDPrefix: tp.MemberIDPrefix,
                                    individualMemberIDPrefix: tp.IndividualMemberIDPrefix
                                });
                                if (swap) {
                                    const hhReq = transaction.request();
                                    hhReq.input('householdId', sql.UniqueIdentifier, mctx.HouseholdId);
                                    hhReq.input('tenantId', sql.UniqueIdentifier, effectiveTenantId);
                                    const hhRes = await hhReq.query(`
                                        SELECT MemberId, HouseholdMemberID
                                        FROM oe.Members
                                        WHERE HouseholdId = @householdId
                                          AND (TenantId = @tenantId OR TenantId IS NULL)
                                    `);
                                    for (const row of hhRes.recordset) {
                                        const newHm = swapHouseholdMemberIdPrefix(
                                            row.HouseholdMemberID,
                                            swap.fromPrefix,
                                            swap.toPrefix
                                        );
                                        if (newHm && newHm !== row.HouseholdMemberID) {
                                            const updHm = transaction.request();
                                            updHm.input('memberId', sql.UniqueIdentifier, row.MemberId);
                                            updHm.input('householdMemberID', sql.NVarChar(50), newHm);
                                            updHm.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
                                            await updHm.query(`
                                                UPDATE oe.Members
                                                SET HouseholdMemberID = @householdMemberID,
                                                    ModifiedDate = GETDATE(),
                                                    ModifiedBy = @modifiedBy
                                                WHERE MemberId = @memberId
                                            `);
                                        }
                                    }
                                }
                            }
                        } catch (swapErr) {
                            console.warn('⚠️ HouseholdMemberID prefix swap after group change failed:', swapErr.message);
                        }
                    }
                }
            }

            // Cascade agent changes to the member's household (member + dependents), plus related enrollments/payments.
            if (requestedCascadeAgentId !== undefined && mctx.HouseholdId) {
                const cascadeReq = transaction.request();
                cascadeReq.input('householdId', sql.UniqueIdentifier, mctx.HouseholdId);
                cascadeReq.input('tenantId', sql.UniqueIdentifier, mctx.TenantId);
                cascadeReq.input('newAgentId', sql.UniqueIdentifier, requestedCascadeAgentId);
                cascadeReq.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

                await cascadeReq.query(`
                    UPDATE oe.Members
                    SET AgentId = @newAgentId,
                        ModifiedDate = GETUTCDATE(),
                        ModifiedBy = @modifiedBy
                    WHERE HouseholdId = @householdId
                      AND TenantId = @tenantId
                `);

                await cascadeReq.query(`
                    UPDATE e
                    SET e.AgentId = @newAgentId,
                        e.ModifiedDate = GETUTCDATE(),
                        e.ModifiedBy = @modifiedBy
                    FROM oe.Enrollments e
                    INNER JOIN oe.Members hm ON e.MemberId = hm.MemberId
                    WHERE hm.HouseholdId = @householdId
                      AND hm.TenantId = @tenantId
                `);

                await cascadeReq.query(`
                    UPDATE p
                    SET p.AgentId = @newAgentId,
                        p.ModifiedDate = GETUTCDATE(),
                        p.ModifiedBy = @modifiedBy
                    FROM oe.Payments p
                    INNER JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
                    INNER JOIN oe.Members hm ON e.MemberId = hm.MemberId
                    WHERE hm.HouseholdId = @householdId
                      AND hm.TenantId = @tenantId
                `);

                await cascadeReq.query(`
                    UPDATE oe.Payments
                    SET AgentId = @newAgentId,
                        ModifiedDate = GETUTCDATE(),
                        ModifiedBy = @modifiedBy
                    WHERE HouseholdId = @householdId
                      AND TenantId = @tenantId
                `);

                console.log('✅ Cascaded member agent update to household members, enrollments, and payments:', {
                    memberId: id,
                    householdId: mctx.HouseholdId,
                    tenantId: mctx.TenantId,
                    newAgentId: requestedCascadeAgentId
                });
            }

            // If member is being terminated, also update enrollment termination dates
            if (updateData.status === 'Terminated' && updateData.terminationDate) {
                console.log('🔍 Updating enrollment termination dates for member:', id);
                const enrollmentRequest = transaction.request();
                enrollmentRequest.input('memberId', sql.UniqueIdentifier, id);
                enrollmentRequest.input('terminationDate', sql.Date, updateData.terminationDate);
                
                const enrollmentUpdateResult = await enrollmentRequest.query(`
                    UPDATE oe.Enrollments 
                    SET TerminationDate = @terminationDate, 
                        Status = 'Terminated',
                        ModifiedDate = GETUTCDATE()
                    WHERE MemberId = @memberId AND Status = 'Active'
                `);
                
                console.log('✅ Updated enrollment termination dates, rows affected:', enrollmentUpdateResult.rowsAffected[0]);
            }
            
            // Note: When a member is unterminated (status set to 'Active' and terminationDate set to null),
            // we ONLY restore the member's status. Enrollments remain terminated and the member must
            // manually re-enroll in products through the enrollment process.

            await transaction.commit();

            // Fetch and return the updated member data
            const returnRequest = pool.request();
            returnRequest.input('memberId', sql.UniqueIdentifier, id);
            
            const updatedMemberResult = await returnRequest.query(`
                SELECT 
                    m.MemberId,
                    m.UserId,
                    m.GroupId,
                    m.RelationshipType,
                    m.MemberSequence,
                    m.Status,
                    m.DateOfBirth,
                    m.Gender,
                    m.Address,
                    m.City,
                    m.State,
                    m.Zip,
                    m.SSN,
                    m.HireDate,
                    m.CreatedDate,
                    m.ModifiedDate,
                    u.FirstName,
                    u.LastName,
                    u.Email,
                    u.PhoneNumber
                FROM oe.Members m
                LEFT JOIN oe.Users u ON m.UserId = u.UserId
                WHERE m.MemberId = @memberId
            `);
            
            if (updatedMemberResult.recordset.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Member not found after update'
                });
            }
            
            const updatedMember = updatedMemberResult.recordset[0];
            updatedMember.SSNLast4 = getSSNLast4(updatedMember.SSN) || null;
            delete updatedMember.SSN;
            
            res.json({
                success: true,
                data: updatedMember,
                message: 'Member updated successfully'
            });

        } catch (error) {
            await transaction.rollback();
            throw error;
        }

    } catch (error) {
        console.error('❌ Error updating member:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update member'
        });
    }
});

// DELETE Member — household-aware soft remove: inactive same-household rows (tenant/group scope);
// rename sign-in emails removed_* except @noemail.com (updates oe.Users + oe.Agents).
router.delete('/:id', authorize(['Admin', 'SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner']), async (req, res) => {
    try {
        const { id } = req.params;
        const guidRegex = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
        if (!id || !guidRegex.test(id)) {
            return res.status(400).json({ success: false, message: 'Invalid member ID format' });
        }

        const pool = await getPool();
        const result = await HouseholdMemberRemovalService.executeHouseholdRemoval(pool, req, id, req.user.UserId);
        if (result.error) {
            return res.status(result.error.status).json({ success: false, message: result.error.message });
        }

        res.json({
            success: true,
            message:
                'Member(s) removed: records set inactive and kept for history. Sign-in emails were prefixed with removed_* where applicable (skipped @noemail.com addresses).',
            data: result.data
        });
    } catch (error) {
        console.error('❌ Error deleting member:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete member'
        });
    }
});

// GET Household members
router.get('/:id/household', async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await getPool();
        
        // First get the household ID of the member
        const householdRequest = pool.request();
        householdRequest.input('memberId', sql.UniqueIdentifier, id);
        
        const householdResult = await householdRequest.query(`
            SELECT HouseholdId 
            FROM oe.Members 
            WHERE MemberId = @memberId
        `);
        
        if (householdResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found'
            });
        }
        
        const householdId = householdResult.recordset[0].HouseholdId;
        
        // Get all members in the household EXCEPT the current member
        const membersRequest = pool.request();
        membersRequest.input('householdId', sql.UniqueIdentifier, householdId);
        membersRequest.input('currentMemberId', sql.UniqueIdentifier, id);
        
        const result = await membersRequest.query(`
            SELECT 
                m.MemberId, m.UserId, m.MemberSequence, m.RelationshipType,
                m.Status, m.DateOfBirth, m.Gender,
                u.FirstName, u.LastName, u.Email, u.PhoneNumber,
                CASE m.RelationshipType
                    WHEN 'P' THEN 'Primary'
                    WHEN 'S' THEN 'Spouse'
                    WHEN 'C' THEN 'Child'
                    ELSE 'Unknown'
                END as RelationshipDescription
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.HouseholdId = @householdId
            AND m.MemberId != @currentMemberId  -- Exclude the current member
            ORDER BY m.MemberSequence
        `);
        
        res.json({
            success: true,
            data: result.recordset
        });
        
    } catch (error) {
        console.error('❌ Error fetching household members:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch household members'
        });
    }
});

// GET Dependents for a member (by household)
router.get('/:id/dependents', authorize(['Admin','SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await getPool();
        
        // First get the household ID of the member
        const householdRequest = pool.request();
        householdRequest.input('memberId', sql.UniqueIdentifier, id);
        
        const householdResult = await householdRequest.query(`
            SELECT HouseholdId 
            FROM oe.Members 
            WHERE MemberId = @memberId
        `);
        
        if (householdResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found'
            });
        }
        
        const householdId = householdResult.recordset[0].HouseholdId;
        
        // Get all dependents (spouses and children) in the household
        const dependentsRequest = pool.request();
        dependentsRequest.input('householdId', sql.UniqueIdentifier, householdId);
        
        const result = await dependentsRequest.query(`
            SELECT 
                m.MemberId,
                m.RelationshipType,
                m.Status,
                FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                m.Gender,
                u.FirstName,
                u.LastName,
                u.Email,
                u.PhoneNumber,
                CASE m.RelationshipType
                    WHEN 'S' THEN 'Spouse'
                    WHEN 'C' THEN 'Child'
                    ELSE 'Unknown'
                END as RelationshipDescription
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.HouseholdId = @householdId
            AND m.RelationshipType IN ('S', 'C')
            AND m.Status != 'Terminated'
            ORDER BY 
                CASE m.RelationshipType
                    WHEN 'S' THEN 1
                    WHEN 'C' THEN 2
                END,
                m.MemberSequence
        `);
        
        res.json({
            success: true,
            data: result.recordset
        });
        
    } catch (error) {
        console.error('❌ Error fetching dependents:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch dependents'
        });
    }
});

// GET Member with full household details
router.get('/:id/with-household', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin', 'VendorAdmin', 'VendorAgent']), async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await getPool();

        // Vendor roles may only access members enrolled in their products.
        const userRoles = getUserRoles(req.user);
        const isVendorOnly =
            !userRoles.some((r) => ['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin'].includes(r)) &&
            userRoles.some((r) => r === 'VendorAdmin' || r === 'VendorAgent');
        if (isVendorOnly) {
            const vendorId = req.user.VendorId;
            if (!vendorId) {
                return res.status(403).json({ success: false, message: 'Insufficient permissions' });
            }
            const guardResult = await pool.request()
                .input('memberId', sql.UniqueIdentifier, id)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .query(`
                    SELECT TOP 1 m.MemberId
                    FROM oe.Members m
                    INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
                    INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                    WHERE m.MemberId = @memberId AND p.VendorId = @vendorId
                `);
            if (guardResult.recordset.length === 0) {
                return res.status(403).json({ success: false, message: 'Insufficient permissions' });
            }
        }
        
        // Get member details
        const memberRequest = pool.request();
        memberRequest.input('memberId', sql.UniqueIdentifier, id);
        
        let memberQuery = `
            SELECT 
                m.MemberId, m.UserId, m.GroupId, m.HouseholdId, m.MemberSequence,
                m.HouseholdMemberID, m.RelationshipType, m.Status, m.CreatedDate, 
                FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                FORMAT(m.HireDate, 'yyyy-MM-dd') as HireDate,
                m.Gender, m.Address, m.City, m.State, m.Zip,
                m.WorkLocation, m.LocationId, m.JobPosition, m.Tier, m.TobaccoUse,
                m.SSN,
                u.FirstName, u.LastName, u.Email, u.PhoneNumber,
                u.TenantId, t.Name as TenantName,
                t.MemberIDPrefix as TenantMemberIDPrefix,
                t.IndividualMemberIDPrefix as TenantIndividualMemberIDPrefix,
                CASE WHEN g.GroupId IS NOT NULL THEN 'LB' ELSE 'SB' END as BillType,
                g.Name as GroupName,
                g.LogoUrl as GroupLogoUrl,
                CASE m.RelationshipType
                    WHEN 'P' THEN 'Primary'
                    WHEN 'S' THEN 'Spouse'
                    WHEN 'C' THEN 'Child'
                    ELSE 'Unknown'
                END as RelationshipDescription,
                -- Agent information
                m.AgentId,
                ag.FirstName + ' ' + ag.LastName as AgentName,
                ag.Email as AgentEmail,
                a.AgencyId,
                agy.AgencyName,
                -- Group agent information
                g.AgentId as GroupAgentId,
                gag.FirstName + ' ' + gag.LastName as GroupAgentName,
                gag.Email as GroupAgentEmail,
                -- Include enrollment stats
                (SELECT COUNT(*) FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Active') as ActiveEnrollments,
                (SELECT COUNT(*) FROM oe.Enrollments e WHERE e.MemberId = m.MemberId) as TotalEnrollments,
                ${MEMBER_LIST_MONTHLY_PREMIUM_SQL},
                ${MEMBER_LIST_ENROLLMENT_STATUS_SQL},
                ${MEMBER_LIST_ENROLLMENT_LINK_SENT_AT_SQL}
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            LEFT JOIN oe.Tenants t ON u.TenantId = t.TenantId
            LEFT JOIN oe.Agents a ON m.AgentId = a.AgentId
            LEFT JOIN oe.Users ag ON a.UserId = ag.UserId
            LEFT JOIN oe.Agencies agy ON a.AgencyId = agy.AgencyId
            LEFT JOIN oe.Agents ga ON g.AgentId = ga.AgentId
            LEFT JOIN oe.Users gag ON ga.UserId = gag.UserId
            WHERE m.MemberId = @memberId
        `;
        
        // Tenant filter for staff roles. Vendor-only users are tenant-agnostic here —
        // they already passed the vendor-enrollment guard above (vendor portal users
        // often belong to a parent tenant while members sit on product tenants).
        const skipTenantFilter = req.user.currentRole === 'SysAdmin' || isVendorOnly;
        if (!skipTenantFilter) {
            memberQuery += ' AND u.TenantId = @tenantId';
            memberRequest.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        // Add group filtering for GroupAdmin users
        if (req.user.currentRole === 'GroupAdmin') {
            // Get GroupAdmin's group ID
            let userGroupId = req.user.GroupId || req.user.groupId;
            
            // If GroupId not in JWT, query from GroupAdmins table
            if (!userGroupId) {
                const groupIdQuery = `
                    SELECT GroupId 
                    FROM oe.GroupAdmins 
                    WHERE UserId = @userId AND Status = 'Active'
                `;
                const groupIdRequest = pool.request();
                groupIdRequest.input('userId', sql.UniqueIdentifier, req.user.UserId);
                const groupIdResult = await groupIdRequest.query(groupIdQuery);
                
                if (groupIdResult.recordset.length > 0 && groupIdResult.recordset[0].GroupId) {
                    userGroupId = groupIdResult.recordset[0].GroupId;
                }
            }
            
            if (userGroupId) {
                memberQuery += ' AND m.GroupId = @userGroupId';
                memberRequest.input('userGroupId', sql.UniqueIdentifier, userGroupId);
            } else {
                // GroupAdmin has no group assigned - deny access
                return res.status(403).json({
                    success: false,
                    message: 'Access denied: No group assigned',
                    code: 'NO_GROUP_ASSIGNED'
                });
            }
        }
        
        const memberResult = await memberRequest.query(memberQuery);
        
        if (memberResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found'
            });
        }
        
        const member = memberResult.recordset[0];
        member.SSNLast4 = getSSNLast4(member.SSN) || null;
        delete member.SSN;
        
        // Get all household members EXCEPT the current member
        const householdRequest = pool.request();
        householdRequest.input('householdId', sql.UniqueIdentifier, member.HouseholdId);
        householdRequest.input('currentMemberId', sql.UniqueIdentifier, id);
        
        const householdResult = await householdRequest.query(`
            SELECT 
                m.MemberId, m.UserId, m.GroupId, m.MemberSequence, m.HouseholdMemberID, m.RelationshipType,
                m.Status, m.DateOfBirth, m.Gender,
                m.SSN,
                u.FirstName, u.LastName, u.Email, u.PhoneNumber,
                CASE m.RelationshipType
                    WHEN 'P' THEN 'Primary'
                    WHEN 'S' THEN 'Spouse'
                    WHEN 'C' THEN 'Child'
                    ELSE 'Unknown'
                END as RelationshipDescription,
                (SELECT COUNT(*) FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Active') as ActiveEnrollments
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.HouseholdId = @householdId
            AND m.MemberId != @currentMemberId  -- Exclude the current member
            ORDER BY m.MemberSequence
        `);

        // Same as primary member: expose last-4 for UI, never send encrypted SSN in JSON
        for (const hm of householdResult.recordset) {
            hm.SSNLast4 = getSSNLast4(hm.SSN) || null;
            delete hm.SSN;
            hm.TenantMemberIDPrefix = member.TenantMemberIDPrefix;
            hm.TenantIndividualMemberIDPrefix = member.TenantIndividualMemberIDPrefix;
        }
        
        res.json({
            success: true,
            data: {
                member: member,
                householdMembers: householdResult.recordset
            }
        });
        
    } catch (error) {
        console.error('❌ Error fetching member with household:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch member details'
        });
    }
});

const MEMBER_PM_ACTIVE_STATUSES_SQL = `('Active', 'PendingProcessorVault')`;
const MEMBER_PM_ADMIN_EDITABLE_STATUSES_SQL = `('Active', 'PendingProcessorVault', 'Inactive')`;

function mapMemberPaymentMethodRow(pm, normUid) {
    const ownerUserId = normUid(pm.MemberOwnerUserId);
    const modByUserId = normUid(pm.ModifiedBy);
    let lastUpdatedByActor = 'unknown';
    if (modByUserId && ownerUserId && modByUserId === ownerUserId) {
        lastUpdatedByActor = 'member';
    } else if (modByUserId) {
        lastUpdatedByActor = 'staff';
    }
    const modifierName = [pm.ModifierFirstName, pm.ModifierLastName]
        .filter(Boolean)
        .join(' ')
        .trim();
    return {
        paymentMethodId: pm.PaymentMethodId,
        paymentMethodType: pm.PaymentMethodType,
        isDefault: pm.IsDefault,
        status: pm.Status,
        bankName: pm.BankName,
        accountType: pm.AccountType,
        routingNumber: pm.RoutingNumber,
        accountNumberLast4: pm.AccountNumberLast4,
        accountHolderName: pm.AccountHolderName,
        cardBrand: pm.CardBrand,
        cardLast4: pm.CardLast4,
        expiryMonth: pm.ExpiryMonth,
        expiryYear: pm.ExpiryYear,
        cardholderName: pm.CardholderName,
        billingAddress: pm.BillingAddress,
        billingAddress2: pm.BillingAddress2,
        billingCity: pm.BillingCity,
        billingState: pm.BillingState,
        billingZip: pm.BillingZip,
        billingCountry: pm.BillingCountry,
        processorCustomerId: pm.ProcessorCustomerId || null,
        processorPaymentMethodId: pm.ProcessorPaymentMethodId || null,
        createdDate: pm.CreatedDate,
        modifiedDate: pm.ModifiedDate,
        modifiedByUserId: pm.ModifiedBy || null,
        modifiedByName: modifierName || null,
        modifiedByEmail: pm.ModifierEmail || null,
        lastUpdatedByActor
    };
}

/**
 * GET /api/members/:id/payment-methods
 * Get payment methods for a specific member (Admin access)
 * Query: includeRemoved=true — also returns soft-removed (Inactive) methods in `removed`.
 */
router.get('/:id/payment-methods', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await getPool();
        
        // First, verify member exists and get member details for access control
        const memberCheckRequest = pool.request();
        memberCheckRequest.input('memberId', sql.UniqueIdentifier, id);
        
        const memberCheckQuery = `
            SELECT m.MemberId, m.GroupId, m.HouseholdId, u.TenantId
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `;
        
        let finalMemberQuery = memberCheckQuery;
        
        // Add tenant filtering for non-SysAdmin users
        if (req.user.currentRole !== 'SysAdmin') {
            finalMemberQuery += ' AND u.TenantId = @tenantId';
            memberCheckRequest.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        // Add group filtering for GroupAdmin users
        if (req.user.currentRole === 'GroupAdmin') {
            // Get GroupAdmin's group ID
            let userGroupId = req.user.GroupId || req.user.groupId;
            
            // If GroupId not in JWT, query from GroupAdmins table
            if (!userGroupId) {
                const groupIdQuery = `
                    SELECT GroupId 
                    FROM oe.GroupAdmins 
                    WHERE UserId = @userId AND Status = 'Active'
                `;
                const groupIdRequest = pool.request();
                groupIdRequest.input('userId', sql.UniqueIdentifier, req.user.UserId);
                const groupIdResult = await groupIdRequest.query(groupIdQuery);
                
                if (groupIdResult.recordset.length > 0 && groupIdResult.recordset[0].GroupId) {
                    userGroupId = groupIdResult.recordset[0].GroupId;
                }
            }
            
            if (userGroupId) {
                finalMemberQuery += ' AND m.GroupId = @userGroupId';
                memberCheckRequest.input('userGroupId', sql.UniqueIdentifier, userGroupId);
            } else {
                // GroupAdmin has no group assigned - deny access
                return res.status(403).json({
                    success: false,
                    message: 'Access denied: No group assigned',
                    code: 'NO_GROUP_ASSIGNED'
                });
            }
        }
        
        const memberCheckResult = await memberCheckRequest.query(finalMemberQuery);
        
        if (memberCheckResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found or access denied'
            });
        }

        // Payment methods are stored on the household primary; use primary's MemberId when member has a household so linking DIME (saved to primary) shows on refetch
        let paymentMethodsMemberId = id;
        const memberRow = memberCheckResult.recordset[0];
        if (memberRow.HouseholdId) {
            const primaryResult = await pool.request()
                .input('householdId', sql.UniqueIdentifier, memberRow.HouseholdId)
                .query(`
                    SELECT MemberId FROM oe.Members
                    WHERE HouseholdId = @householdId AND RelationshipType = 'P'
                `);
            const primaryMemberId = primaryResult.recordset?.[0]?.MemberId;
            if (primaryMemberId) {
                paymentMethodsMemberId = primaryMemberId;
            }
        }

        // Check if any payment method has a DIME customer ID (for "overwrite" warning in Link DIME customer modal)
        const hasExistingDimeCustomerIdResult = await pool.request()
            .input('memberId', sql.UniqueIdentifier, paymentMethodsMemberId)
            .query(`
                SELECT 1 AS HasExisting FROM oe.MemberPaymentMethods
                WHERE MemberId = @memberId AND Status = 'Active' AND ProcessorCustomerId IS NOT NULL
            `);
        const hasExistingDimeCustomerId = !!(hasExistingDimeCustomerIdResult.recordset && hasExistingDimeCustomerIdResult.recordset.length > 0);

        // Get payment methods for the member (primary when in a household, so we show the same methods for any household member)
        const paymentMethodsRequest = pool.request();
        paymentMethodsRequest.input('memberId', sql.UniqueIdentifier, paymentMethodsMemberId);

        const paymentMethodsQuery = `
            SELECT 
                mpm.PaymentMethodId,
                mpm.PaymentMethodType,
                mpm.IsDefault,
                mpm.Status,
                mpm.BankName,
                mpm.AccountType,
                mpm.RoutingNumber,
                mpm.AccountNumberLast4,
                mpm.AccountHolderName,
                mpm.CardBrand,
                mpm.CardLast4,
                mpm.ExpiryMonth,
                mpm.ExpiryYear,
                mpm.CardholderName,
                mpm.BillingAddress,
                mpm.BillingAddress2,
                mpm.BillingCity,
                mpm.BillingState,
                mpm.BillingZip,
                mpm.BillingCountry,
                mpm.ProcessorCustomerId,
                mpm.ProcessorPaymentMethodId,
                mpm.CreatedDate,
                mpm.ModifiedDate,
                mpm.ModifiedBy,
                mem.UserId AS MemberOwnerUserId,
                modU.FirstName AS ModifierFirstName,
                modU.LastName AS ModifierLastName,
                modU.Email AS ModifierEmail
            FROM oe.MemberPaymentMethods mpm
            INNER JOIN oe.Members mem ON mpm.MemberId = mem.MemberId
            LEFT JOIN oe.Users modU ON mpm.ModifiedBy = modU.UserId
            WHERE mpm.MemberId = @memberId
                AND mpm.Status IN ${MEMBER_PM_ACTIVE_STATUSES_SQL}
            ORDER BY mpm.IsDefault DESC, mpm.CreatedDate DESC
        `;
        
        const paymentMethodsResult = await paymentMethodsRequest.query(paymentMethodsQuery);
        
        const normUid = v => {
            if (v == null || v === undefined) return null;
            const s = String(v).trim().replace(/^\{/, '').replace(/\}$/, '').toLowerCase();
            return s || null;
        };

        const paymentMethods = paymentMethodsResult.recordset.map((pm) => mapMemberPaymentMethodRow(pm, normUid));

        let removed = [];
        if (req.query.includeRemoved === 'true' || req.query.includeRemoved === '1') {
            const removedResult = await pool.request()
                .input('memberId', sql.UniqueIdentifier, paymentMethodsMemberId)
                .query(`
                    SELECT
                        mpm.PaymentMethodId,
                        mpm.PaymentMethodType,
                        mpm.IsDefault,
                        mpm.Status,
                        mpm.BankName,
                        mpm.AccountType,
                        mpm.RoutingNumber,
                        mpm.AccountNumberLast4,
                        mpm.AccountHolderName,
                        mpm.CardBrand,
                        mpm.CardLast4,
                        mpm.ExpiryMonth,
                        mpm.ExpiryYear,
                        mpm.CardholderName,
                        mpm.BillingAddress,
                        mpm.BillingAddress2,
                        mpm.BillingCity,
                        mpm.BillingState,
                        mpm.BillingZip,
                        mpm.BillingCountry,
                        mpm.ProcessorCustomerId,
                        mpm.ProcessorPaymentMethodId,
                        mpm.CreatedDate,
                        mpm.ModifiedDate,
                        mpm.ModifiedBy,
                        mem.UserId AS MemberOwnerUserId,
                        modU.FirstName AS ModifierFirstName,
                        modU.LastName AS ModifierLastName,
                        modU.Email AS ModifierEmail
                    FROM oe.MemberPaymentMethods mpm
                    INNER JOIN oe.Members mem ON mpm.MemberId = mem.MemberId
                    LEFT JOIN oe.Users modU ON mpm.ModifiedBy = modU.UserId
                    WHERE mpm.MemberId = @memberId
                      AND mpm.Status = 'Inactive'
                    ORDER BY mpm.ModifiedDate DESC, mpm.CreatedDate DESC
                `);
            removed = (removedResult.recordset || []).map((pm) => mapMemberPaymentMethodRow(pm, normUid));
        }
        
        res.json({
            success: true,
            data: paymentMethods,
            removed,
            hasExistingDimeCustomerId
        });
        
    } catch (error) {
        console.error('❌ Error fetching member payment methods:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch payment methods',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * POST /api/members/:id/payment-methods
 * Add payment method for a member (Admin access)
 * Uses existing DIME customer if member has ProcessorCustomerId; otherwise creates new customer.
 */
router.post('/:id/payment-methods', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await getPool();

        // Verify member exists (reuse same access control as GET payment-methods)
        const memberCheckRequest = pool.request();
        memberCheckRequest.input('memberId', sql.UniqueIdentifier, id);
        let memberCheckQuery = `
            SELECT m.MemberId, m.GroupId, m.HouseholdId, m.ProcessorCustomerId,
                   u.TenantId, u.FirstName, u.LastName, u.Email, u.PhoneNumber,
                   m.Address, m.City, m.State, m.Zip
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `;
        if (req.user.currentRole !== 'SysAdmin') {
            memberCheckQuery += ' AND u.TenantId = @tenantId';
            memberCheckRequest.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        if (req.user.currentRole === 'GroupAdmin') {
            let userGroupId = req.user.GroupId || req.user.groupId;
            if (!userGroupId) {
                const gaResult = await pool.request()
                    .input('userId', sql.UniqueIdentifier, req.user.UserId)
                    .query('SELECT GroupId FROM oe.GroupAdmins WHERE UserId = @userId AND Status = \'Active\'');
                userGroupId = gaResult.recordset?.[0]?.GroupId;
            }
            if (userGroupId) {
                memberCheckQuery += ' AND m.GroupId = @userGroupId';
                memberCheckRequest.input('userGroupId', sql.UniqueIdentifier, userGroupId);
            } else {
                return res.status(403).json({ success: false, message: 'Access denied: No group assigned' });
            }
        }

        const memberResult = await memberCheckRequest.query(memberCheckQuery);
        if (!memberResult.recordset?.length) {
            return res.status(404).json({ success: false, message: 'Member not found or access denied' });
        }

        const memberRow = memberResult.recordset[0];
        if (memberRow.GroupId) {
            return res.status(400).json({
                success: false,
                message: 'Payment methods cannot be added for group members. Group members use group billing.'
            });
        }

        // Resolve primary member (payment methods stored on primary for household)
        let paymentMethodsMemberId = id;
        if (memberRow.HouseholdId) {
            const primaryResult = await pool.request()
                .input('householdId', sql.UniqueIdentifier, memberRow.HouseholdId)
                .query(`
                    SELECT m.MemberId, m.ProcessorCustomerId, u.FirstName, u.LastName, u.Email, u.PhoneNumber, m.Address, m.City, m.State, m.Zip
                    FROM oe.Members m
                    JOIN oe.Users u ON m.UserId = u.UserId
                    WHERE m.HouseholdId = @householdId AND m.RelationshipType = 'P'
                `);
            if (primaryResult.recordset?.[0]) {
                paymentMethodsMemberId = primaryResult.recordset[0].MemberId;
            }
        }

        // Get primary member for customer data
        const primaryResult = await pool.request()
            .input('memberId', sql.UniqueIdentifier, paymentMethodsMemberId)
            .query(`
                SELECT m.MemberId, m.ProcessorCustomerId, u.TenantId, u.FirstName, u.LastName, u.Email, u.PhoneNumber, m.Address, m.City, m.State, m.Zip
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE m.MemberId = @memberId
            `);
        const primary = primaryResult.recordset?.[0];
        if (!primary) {
            return res.status(404).json({ success: false, message: 'Primary member not found' });
        }

        // Get DIME customer ID: check MemberPaymentMethods first (link-dime-customer stores there), then oe.Members
        let dimeCustomerId = primary.ProcessorCustomerId;
        if (!dimeCustomerId) {
            const pmResult = await pool.request()
                .input('memberId', sql.UniqueIdentifier, paymentMethodsMemberId)
                .query(`
                    SELECT TOP 1 ProcessorCustomerId FROM oe.MemberPaymentMethods
                    WHERE MemberId = @memberId AND Status = 'Active' AND ProcessorCustomerId IS NOT NULL
                `);
            dimeCustomerId = pmResult.recordset?.[0]?.ProcessorCustomerId;
        }

        if (!dimeCustomerId) {
            // Create new DIME customer
            const customerData = {
                firstName: primary.FirstName,
                lastName: primary.LastName,
                email: primary.Email,
                phone: req.body.phoneNumber || primary.PhoneNumber || '',
                billingAddress: req.body.billingAddress || primary.Address || '',
                billingCity: req.body.billingCity || primary.City || '',
                billingState: req.body.billingState || primary.State || '',
                billingZip: req.body.billingZip || primary.Zip || '',
                billingCountry: req.body.billingCountry || 'US'
            };
            const customerResult = await PaymentMethodService.ensureDimeCustomer(customerData, 'member', paymentMethodsMemberId, primary.TenantId || memberRow.TenantId);
            if (!customerResult.success) {
                return res.status(500).json({
                    success: false,
                    message: customerResult.error?.message || 'Failed to create payment processor customer'
                });
            }
            dimeCustomerId = customerResult.customerId;
        }

        const {
            paymentMethodType,
            bankName,
            accountType,
            routingNumber,
            accountNumber,
            accountHolderName,
            cardBrand,
            cardNumber,
            expiryMonth,
            expiryYear,
            cvv,
            cardholderName,
            billingAddress,
            billingAddress2,
            billingCity,
            billingState,
            billingZip,
            billingCountry,
            isDefault
        } = req.body;

        if (!paymentMethodType) {
            return res.status(400).json({ success: false, message: 'Payment method type is required' });
        }

        const validation = PaymentMethodService.validatePaymentMethodData(req.body, paymentMethodType);
        if (!validation.isValid) {
            return res.status(400).json({
                success: false,
                message: 'Invalid payment method data',
                errors: validation.errors
            });
        }

        const previousProcessorPaymentMethodId = isDefault
            ? await fetchPreviousDefaultProcessorPmId(pool, paymentMethodsMemberId)
            : null;

        if (isDefault) {
            const removeDefaultReq = pool.request();
            removeDefaultReq.input('memberId', sql.UniqueIdentifier, paymentMethodsMemberId);
            removeDefaultReq.input('tenantId', sql.UniqueIdentifier, primary.TenantId || memberRow.TenantId);
            removeDefaultReq.input('userId', sql.UniqueIdentifier, req.user.UserId);
            await removeDefaultReq.query(`
                UPDATE oe.MemberPaymentMethods
                SET IsDefault = 0, ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
                WHERE MemberId = @memberId AND TenantId = @tenantId
            `);
        }

        const dimeResult = await PaymentMethodService.createPaymentMethod(
            req.body,
            dimeCustomerId,
            primary.TenantId || memberRow.TenantId,
            { requireTokenization: true }
        );

        if (!dimeResult.success) {
            return res.status(400).json({
                success: false,
                message: dimeResult.error?.message || 'Failed to create payment method'
            });
        }

        const actingUserId = req.user?.UserId;
        if (!actingUserId) {
            return res.status(401).json({ success: false, message: 'User not authenticated' });
        }

        const insertResult = await PaymentMethodService.insertPaymentMethod(
            req.body,
            'member',
            paymentMethodsMemberId,
            dimeResult,
            actingUserId,
            primary.TenantId || memberRow.TenantId
        );

        if (!insertResult.success) {
            return res.status(500).json({
                success: false,
                message: insertResult.error?.message || 'Failed to save payment method'
            });
        }

        if (isDefault) {
            await PaymentMethodService.updatePaymentMethodDefaults(
                'member',
                paymentMethodsMemberId,
                insertResult.paymentMethodId,
                actingUserId,
                primary.TenantId || memberRow.TenantId
            );
        }

        const recurringSync = isDefault && memberRow.HouseholdId
            ? await runPaymentMethodRecurringSync(pool, {
                householdId: memberRow.HouseholdId,
                tenantId: primary.TenantId || memberRow.TenantId,
                paymentMethodId: insertResult.paymentMethodId,
                previousProcessorPaymentMethodId,
            })
            : {};

        return res.json({
            success: true,
            message: 'Payment method added successfully',
            data: {
                paymentMethodId: insertResult.paymentMethodId,
                ...recurringSync,
            },
        });
    } catch (error) {
        console.error('❌ Error adding member payment method:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to add payment method'
        });
    }
});

/**
 * PUT /api/members/:id/payment-methods/:paymentMethodId
 * Update billing / holder metadata for an existing household payment method (admin).
 * Mirrors member self-service DB update; partial body merges with stored row so last4/card are not wiped.
 */
router.put(
    '/:id/payment-methods/:paymentMethodId',
    authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']),
    async (req, res) => {
        try {
            const { id, paymentMethodId } = req.params;
            const pool = await getPool();
            const actingUserId = req.user?.UserId;
            if (!actingUserId) {
                return res.status(401).json({ success: false, message: 'User not authenticated' });
            }

            const memberCheckRequest = pool.request();
            memberCheckRequest.input('memberId', sql.UniqueIdentifier, id);
            let memberCheckQuery = `
            SELECT m.MemberId, m.GroupId, m.HouseholdId, u.TenantId
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `;
            if (req.user.currentRole !== 'SysAdmin') {
                memberCheckQuery += ' AND u.TenantId = @tenantId';
                memberCheckRequest.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
            }
            if (req.user.currentRole === 'GroupAdmin') {
                let userGroupId = req.user.GroupId || req.user.groupId;
                if (!userGroupId) {
                    const gaResult = await pool
                        .request()
                        .input('userId', sql.UniqueIdentifier, req.user.UserId)
                        .query('SELECT GroupId FROM oe.GroupAdmins WHERE UserId = @userId AND Status = \'Active\'');
                    userGroupId = gaResult.recordset?.[0]?.GroupId;
                }
                if (userGroupId) {
                    memberCheckQuery += ' AND m.GroupId = @userGroupId';
                    memberCheckRequest.input('userGroupId', sql.UniqueIdentifier, userGroupId);
                } else {
                    return res.status(403).json({ success: false, message: 'Access denied: No group assigned' });
                }
            }

            const memberResult = await memberCheckRequest.query(memberCheckQuery);
            if (!memberResult.recordset?.length) {
                return res.status(404).json({ success: false, message: 'Member not found or access denied' });
            }

            const memberRow = memberResult.recordset[0];
            if (memberRow.GroupId) {
                return res.status(400).json({
                    success: false,
                    message: 'Payment methods for group members are managed at group level.',
                });
            }

            let paymentMethodsMemberId = id;
            if (memberRow.HouseholdId) {
                const primaryResult = await pool.request()
                    .input('householdId', sql.UniqueIdentifier, memberRow.HouseholdId)
                    .query(`
                    SELECT MemberId FROM oe.Members
                    WHERE HouseholdId = @householdId AND RelationshipType = 'P'
                `);
                if (primaryResult.recordset?.[0]?.MemberId) {
                    paymentMethodsMemberId = primaryResult.recordset[0].MemberId;
                }
            }

            const pmSel = await pool
                .request()
                .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
                .input('memberId', sql.UniqueIdentifier, paymentMethodsMemberId)
                .query(`
                SELECT TOP 1 * FROM oe.MemberPaymentMethods mpm
                WHERE mpm.PaymentMethodId = @paymentMethodId
                  AND mpm.MemberId = @memberId
                  AND mpm.Status IN ${MEMBER_PM_ADMIN_EDITABLE_STATUSES_SQL}
            `);

            if (!pmSel.recordset?.length) {
                return res.status(404).json({
                    success: false,
                    message: 'Payment method not found or access denied',
                });
            }

            const e = pmSel.recordset[0];
            const body = req.body || {};

            const bankName =
                Object.prototype.hasOwnProperty.call(body, 'bankName') ? body.bankName : e.BankName;
            const accountType =
                Object.prototype.hasOwnProperty.call(body, 'accountType') ? body.accountType : e.AccountType;
            const routingNumberRaw = Object.prototype.hasOwnProperty.call(body, 'routingNumber')
                ? body.routingNumber
                : e.RoutingNumber;
            const routingNumber =
                routingNumberRaw == null || routingNumberRaw === ''
                    ? null
                    : String(routingNumberRaw).replace(/\D/g, '').slice(0, 9) || null;
            if (routingNumber && e.PaymentMethodType === 'ACH' && routingNumber.length !== 9) {
                return res.status(400).json({ success: false, message: 'Routing number must be 9 digits' });
            }

            const accountHolderName =
                Object.prototype.hasOwnProperty.call(body, 'accountHolderName')
                    ? body.accountHolderName
                    : e.AccountHolderName;
            const cardholderName =
                Object.prototype.hasOwnProperty.call(body, 'cardholderName')
                    ? body.cardholderName
                    : e.CardholderName;
            const billingAddress =
                Object.prototype.hasOwnProperty.call(body, 'billingAddress')
                    ? body.billingAddress
                    : e.BillingAddress;
            const billingAddress2 =
                Object.prototype.hasOwnProperty.call(body, 'billingAddress2')
                    ? body.billingAddress2
                    : e.BillingAddress2;
            const billingCity =
                Object.prototype.hasOwnProperty.call(body, 'billingCity')
                    ? body.billingCity
                    : e.BillingCity;
            const billingState =
                Object.prototype.hasOwnProperty.call(body, 'billingState')
                    ? body.billingState
                    : e.BillingState;
            const billingZip =
                Object.prototype.hasOwnProperty.call(body, 'billingZip')
                    ? body.billingZip
                    : e.BillingZip;
            const billingCountry =
                Object.prototype.hasOwnProperty.call(body, 'billingCountry')
                    ? body.billingCountry || 'US'
                    : e.BillingCountry || 'US';

            let expiryMonth =
                Object.prototype.hasOwnProperty.call(body, 'expiryMonth') ? body.expiryMonth : e.ExpiryMonth;
            let expiryYear =
                Object.prototype.hasOwnProperty.call(body, 'expiryYear') ? body.expiryYear : e.ExpiryYear;

            let cardLast4 = e.CardLast4;
            let cardBrand = e.CardBrand;
            const rawCard =
                typeof body.cardNumber === 'string' ? body.cardNumber.replace(/\D/g, '') : '';
            if (rawCard.length >= 13) {
                cardLast4 = rawCard.slice(-4);
                cardBrand = dimeCardBrand.getCardBrandOrNull(rawCard) || cardBrand;
            }

            let accountNumberLast4 = e.AccountNumberLast4;
            const rawAcct =
                typeof body.accountNumber === 'string' ? body.accountNumber.replace(/\D/g, '') : '';
            if (rawAcct.length >= 4) {
                accountNumberLast4 = rawAcct.slice(-4);
            }

            let nextAccountNumberEncrypted = e.AccountNumberEncrypted;
            let nextRoutingNumberEncrypted = e.RoutingNumberEncrypted;
            if (String(e.PaymentMethodType || '').toUpperCase() === 'ACH') {
                if (rawAcct.length >= 4) {
                    if (routingNumber && rawAcct === routingNumber) {
                        return res.status(400).json({
                            success: false,
                            message: 'Account number cannot match the routing number. Check both fields and save again.'
                        });
                    }
                    const acctEncWrap = encryptionService.encryptPaymentData({ accountNumber: rawAcct });
                    nextAccountNumberEncrypted = acctEncWrap.accountNumberEncrypted || null;
                }
                if (routingNumber && routingNumber.length === 9) {
                    const rtEncWrap = encryptionService.encryptPaymentData({ routingNumber });
                    nextRoutingNumberEncrypted = rtEncWrap.routingNumberEncrypted || null;
                }
            }

            const wantsDefault = body.isDefault === true || body.isDefault === 1 || body.isDefault === 'true';
            const previousProcessorPaymentMethodId = wantsDefault && !e.IsDefault
                ? await fetchPreviousDefaultProcessorPmId(pool, paymentMethodsMemberId)
                : null;
            if (wantsDefault && !e.IsDefault) {
                const clearOthers = pool.request();
                clearOthers.input('memberId', sql.UniqueIdentifier, paymentMethodsMemberId);
                clearOthers.input('tenantId', sql.UniqueIdentifier, e.TenantId);
                clearOthers.input('userId', sql.UniqueIdentifier, actingUserId);
                clearOthers.input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId);
                await clearOthers.query(`
                    UPDATE oe.MemberPaymentMethods
                    SET IsDefault = 0, ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
                    WHERE MemberId = @memberId AND TenantId = @tenantId AND PaymentMethodId <> @paymentMethodId
                `);
            }

            const isDefault = wantsDefault ? true : !!e.IsDefault;

            const updateRequest = pool.request();
            updateRequest.input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId);
            updateRequest.input('userId', sql.UniqueIdentifier, actingUserId);
            updateRequest.input('bankName', sql.NVarChar, bankName || null);
            updateRequest.input('accountType', sql.NVarChar, accountType || null);
            updateRequest.input('routingNumber', sql.NVarChar, routingNumber || null);
            updateRequest.input('accountNumberLast4', sql.NVarChar, accountNumberLast4 || null);
            updateRequest.input('accountHolderName', sql.NVarChar, accountHolderName || null);
            updateRequest.input('cardBrand', sql.NVarChar, cardBrand || null);
            updateRequest.input('cardLast4', sql.NVarChar, cardLast4 || null);
            updateRequest.input('expiryMonth', sql.Int, expiryMonth ?? null);
            updateRequest.input('expiryYear', sql.Int, expiryYear ?? null);
            updateRequest.input('cardholderName', sql.NVarChar, cardholderName || null);
            updateRequest.input('billingAddress', sql.NVarChar, billingAddress || null);
            updateRequest.input('billingAddress2', sql.NVarChar, billingAddress2 || null);
            updateRequest.input('billingCity', sql.NVarChar, billingCity || null);
            updateRequest.input('billingState', sql.NVarChar, billingState || null);
            updateRequest.input('billingZip', sql.NVarChar, billingZip || null);
            updateRequest.input('billingCountry', sql.NVarChar, billingCountry || 'US');
            updateRequest.input('isDefault', sql.Bit, isDefault);
            updateRequest.input(
                'accountNumberEncrypted',
                sql.NVarChar,
                nextAccountNumberEncrypted ?? null
            );
            updateRequest.input(
                'routingNumberEncrypted',
                sql.NVarChar,
                nextRoutingNumberEncrypted ?? null
            );

            await updateRequest.query(`
                UPDATE oe.MemberPaymentMethods
                SET BankName = @bankName,
                    AccountType = @accountType,
                    RoutingNumber = @routingNumber,
                    RoutingNumberEncrypted = @routingNumberEncrypted,
                    AccountNumberEncrypted = @accountNumberEncrypted,
                    AccountNumberLast4 = @accountNumberLast4,
                    AccountHolderName = @accountHolderName,
                    CardBrand = @cardBrand,
                    CardLast4 = @cardLast4,
                    ExpiryMonth = @expiryMonth,
                    ExpiryYear = @expiryYear,
                    CardholderName = @cardholderName,
                    BillingAddress = @billingAddress,
                    BillingAddress2 = @billingAddress2,
                    BillingCity = @billingCity,
                    BillingState = @billingState,
                    BillingZip = @billingZip,
                    BillingCountry = @billingCountry,
                    IsDefault = @isDefault,
                    ModifiedDate = GETUTCDATE(),
                    ModifiedBy = @userId
                WHERE PaymentMethodId = @paymentMethodId
            `);

            const recurringSync = isDefault && memberRow.HouseholdId
                ? await runPaymentMethodRecurringSync(pool, {
                    householdId: memberRow.HouseholdId,
                    tenantId: e.TenantId,
                    paymentMethodId,
                    previousProcessorPaymentMethodId,
                })
                : {};

            return res.json({
                success: true,
                message: 'Payment method updated successfully',
                data: recurringSync,
            });
        } catch (error) {
            console.error('❌ Error updating member payment method:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to update payment method',
            });
        }
    }
);

/**
 * DELETE /api/members/:id/payment-methods/:paymentMethodId
 * Soft-remove a household payment method (Status = Inactive). Hidden from member portal and admin list.
 */
router.delete(
    '/:id/payment-methods/:paymentMethodId',
    authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']),
    async (req, res) => {
        try {
            const { id, paymentMethodId } = req.params;
            const pool = await getPool();
            const actingUserId = req.user?.UserId;
            if (!actingUserId) {
                return res.status(401).json({ success: false, message: 'User not authenticated' });
            }

            const memberCheckRequest = pool.request();
            memberCheckRequest.input('memberId', sql.UniqueIdentifier, id);
            let memberCheckQuery = `
            SELECT m.MemberId, m.GroupId, m.HouseholdId, u.TenantId
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `;
            if (req.user.currentRole !== 'SysAdmin') {
                memberCheckQuery += ' AND u.TenantId = @tenantId';
                memberCheckRequest.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
            }
            if (req.user.currentRole === 'GroupAdmin') {
                let userGroupId = req.user.GroupId || req.user.groupId;
                if (!userGroupId) {
                    const gaResult = await pool
                        .request()
                        .input('userId', sql.UniqueIdentifier, req.user.UserId)
                        .query('SELECT GroupId FROM oe.GroupAdmins WHERE UserId = @userId AND Status = \'Active\'');
                    userGroupId = gaResult.recordset?.[0]?.GroupId;
                }
                if (userGroupId) {
                    memberCheckQuery += ' AND m.GroupId = @userGroupId';
                    memberCheckRequest.input('userGroupId', sql.UniqueIdentifier, userGroupId);
                } else {
                    return res.status(403).json({ success: false, message: 'Access denied: No group assigned' });
                }
            }

            const memberResult = await memberCheckRequest.query(memberCheckQuery);
            if (!memberResult.recordset?.length) {
                return res.status(404).json({ success: false, message: 'Member not found or access denied' });
            }

            const memberRow = memberResult.recordset[0];
            if (memberRow.GroupId) {
                return res.status(400).json({
                    success: false,
                    message: 'Payment methods for group members are managed at group level.',
                });
            }

            let paymentMethodsMemberId = id;
            if (memberRow.HouseholdId) {
                const primaryResult = await pool.request()
                    .input('householdId', sql.UniqueIdentifier, memberRow.HouseholdId)
                    .query(`
                    SELECT MemberId FROM oe.Members
                    WHERE HouseholdId = @householdId AND RelationshipType = 'P'
                `);
                if (primaryResult.recordset?.[0]?.MemberId) {
                    paymentMethodsMemberId = primaryResult.recordset[0].MemberId;
                }
            }

            const pmSel = await pool
                .request()
                .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
                .input('memberId', sql.UniqueIdentifier, paymentMethodsMemberId)
                .query(`
                SELECT TOP 1
                  mpm.PaymentMethodId,
                  mpm.IsDefault,
                  mpm.ProcessorPaymentMethodId,
                  mpm.TenantId
                FROM oe.MemberPaymentMethods mpm
                WHERE mpm.PaymentMethodId = @paymentMethodId
                  AND mpm.MemberId = @memberId
                  AND mpm.Status IN ('Active', 'PendingProcessorVault')
            `);

            if (!pmSel.recordset?.length) {
                return res.status(404).json({
                    success: false,
                    message: 'Payment method not found or already removed',
                });
            }

            const paymentMethod = pmSel.recordset[0];
            const tenantId = paymentMethod.TenantId || memberRow.TenantId;

            if (paymentMethod.ProcessorPaymentMethodId) {
                const dimeDeleteResult = await DimeService.deletePaymentMethod(
                    paymentMethod.ProcessorPaymentMethodId,
                    tenantId
                );
                if (!dimeDeleteResult.success) {
                    console.warn('⚠️ Staff remove: DIME delete failed (continuing with soft delete):', dimeDeleteResult.error);
                }
            }

            await pool
                .request()
                .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
                .input('userId', sql.UniqueIdentifier, actingUserId)
                .query(`
                UPDATE oe.MemberPaymentMethods
                SET Status = 'Inactive',
                    IsDefault = 0,
                    ModifiedDate = GETUTCDATE(),
                    ModifiedBy = @userId
                WHERE PaymentMethodId = @paymentMethodId
            `);

            if (paymentMethod.IsDefault) {
                await pool
                    .request()
                    .input('memberId', sql.UniqueIdentifier, paymentMethodsMemberId)
                    .input('tenantId', sql.UniqueIdentifier, tenantId)
                    .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
                    .input('userId', sql.UniqueIdentifier, actingUserId)
                    .query(`
                    UPDATE TOP (1) oe.MemberPaymentMethods
                    SET IsDefault = 1,
                        ModifiedDate = GETUTCDATE(),
                        ModifiedBy = @userId
                    WHERE PaymentMethodId IN (
                      SELECT TOP 1 mpm.PaymentMethodId
                      FROM oe.MemberPaymentMethods mpm
                      WHERE mpm.MemberId = @memberId
                        AND mpm.TenantId = @tenantId
                        AND mpm.Status IN ('Active', 'PendingProcessorVault')
                        AND mpm.PaymentMethodId <> @paymentMethodId
                      ORDER BY mpm.CreatedDate DESC
                    )
                `);
            }

            return res.json({
                success: true,
                message: 'Payment method removed. It will no longer appear for the member.',
            });
        } catch (error) {
            console.error('❌ Error removing member payment method:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to remove payment method',
            });
        }
    }
);

/**
 * POST /api/members/:id/payment-methods/:paymentMethodId/restore
 * Restore a soft-removed payment method (Inactive → Active). Member portal will show it again.
 */
router.post(
    '/:id/payment-methods/:paymentMethodId/restore',
    authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']),
    async (req, res) => {
        try {
            const { id, paymentMethodId } = req.params;
            const pool = await getPool();
            const actingUserId = req.user?.UserId;
            if (!actingUserId) {
                return res.status(401).json({ success: false, message: 'User not authenticated' });
            }

            const memberCheckRequest = pool.request();
            memberCheckRequest.input('memberId', sql.UniqueIdentifier, id);
            let memberCheckQuery = `
            SELECT m.MemberId, m.GroupId, m.HouseholdId, u.TenantId
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `;
            if (req.user.currentRole !== 'SysAdmin') {
                memberCheckQuery += ' AND u.TenantId = @tenantId';
                memberCheckRequest.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
            }
            if (req.user.currentRole === 'GroupAdmin') {
                let userGroupId = req.user.GroupId || req.user.groupId;
                if (!userGroupId) {
                    const gaResult = await pool
                        .request()
                        .input('userId', sql.UniqueIdentifier, req.user.UserId)
                        .query('SELECT GroupId FROM oe.GroupAdmins WHERE UserId = @userId AND Status = \'Active\'');
                    userGroupId = gaResult.recordset?.[0]?.GroupId;
                }
                if (userGroupId) {
                    memberCheckQuery += ' AND m.GroupId = @userGroupId';
                    memberCheckRequest.input('userGroupId', sql.UniqueIdentifier, userGroupId);
                } else {
                    return res.status(403).json({ success: false, message: 'Access denied: No group assigned' });
                }
            }

            const memberResult = await memberCheckRequest.query(memberCheckQuery);
            if (!memberResult.recordset?.length) {
                return res.status(404).json({ success: false, message: 'Member not found or access denied' });
            }

            const memberRow = memberResult.recordset[0];
            if (memberRow.GroupId) {
                return res.status(400).json({
                    success: false,
                    message: 'Payment methods for group members are managed at group level.',
                });
            }

            let paymentMethodsMemberId = id;
            if (memberRow.HouseholdId) {
                const primaryResult = await pool.request()
                    .input('householdId', sql.UniqueIdentifier, memberRow.HouseholdId)
                    .query(`
                    SELECT MemberId FROM oe.Members
                    WHERE HouseholdId = @householdId AND RelationshipType = 'P'
                `);
                if (primaryResult.recordset?.[0]?.MemberId) {
                    paymentMethodsMemberId = primaryResult.recordset[0].MemberId;
                }
            }

            const tenantId = memberRow.TenantId;

            const pmSel = await pool
                .request()
                .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
                .input('memberId', sql.UniqueIdentifier, paymentMethodsMemberId)
                .query(`
                SELECT TOP 1 mpm.PaymentMethodId, mpm.Status
                FROM oe.MemberPaymentMethods mpm
                WHERE mpm.PaymentMethodId = @paymentMethodId
                  AND mpm.MemberId = @memberId
                  AND mpm.Status = 'Inactive'
            `);

            if (!pmSel.recordset?.length) {
                return res.status(404).json({
                    success: false,
                    message: 'Removed payment method not found',
                });
            }

            const activeCountResult = await pool
                .request()
                .input('memberId', sql.UniqueIdentifier, paymentMethodsMemberId)
                .input('tenantId', sql.UniqueIdentifier, tenantId)
                .query(`
                SELECT COUNT(*) AS Cnt
                FROM oe.MemberPaymentMethods
                WHERE MemberId = @memberId
                  AND TenantId = @tenantId
                  AND Status IN ${MEMBER_PM_ACTIVE_STATUSES_SQL}
            `);
            const activeCount = Number(activeCountResult.recordset[0]?.Cnt || 0);
            const makeDefault = activeCount === 0;

            await pool
                .request()
                .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
                .input('userId', sql.UniqueIdentifier, actingUserId)
                .input('isDefault', sql.Bit, makeDefault ? 1 : 0)
                .query(`
                UPDATE oe.MemberPaymentMethods
                SET Status = 'Active',
                    IsDefault = @isDefault,
                    ModifiedDate = GETUTCDATE(),
                    ModifiedBy = @userId
                WHERE PaymentMethodId = @paymentMethodId
            `);

            return res.json({
                success: true,
                message: makeDefault
                    ? 'Payment method restored and set as primary. Re-save to the payment processor if needed.'
                    : 'Payment method restored. Re-save to the payment processor if needed.',
            });
        } catch (error) {
            console.error('❌ Error restoring member payment method:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to restore payment method',
            });
        }
    }
);

/**
 * GET /api/members/:id/payment-methods/:paymentMethodId/decrypted-account
 * Returns decrypted ACH account number for admins editing a stored method (not included in list endpoint).
 */
router.get(
    '/:id/payment-methods/:paymentMethodId/decrypted-account',
    authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']),
    async (req, res) => {
        try {
            const { id, paymentMethodId } = req.params;
            const pool = await getPool();

            const memberCheckRequest = pool.request();
            memberCheckRequest.input('memberId', sql.UniqueIdentifier, id);
            let memberCheckQuery = `
            SELECT m.MemberId, m.GroupId, m.HouseholdId, u.TenantId
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `;
            if (req.user.currentRole !== 'SysAdmin') {
                memberCheckQuery += ' AND u.TenantId = @tenantId';
                memberCheckRequest.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
            }
            if (req.user.currentRole === 'GroupAdmin') {
                let userGroupId = req.user.GroupId || req.user.groupId;
                if (!userGroupId) {
                    const gaResult = await pool
                        .request()
                        .input('userId', sql.UniqueIdentifier, req.user.UserId)
                        .query(
                            'SELECT GroupId FROM oe.GroupAdmins WHERE UserId = @userId AND Status = \'Active\''
                        );
                    userGroupId = gaResult.recordset?.[0]?.GroupId;
                }
                if (userGroupId) {
                    memberCheckQuery += ' AND m.GroupId = @userGroupId';
                    memberCheckRequest.input('userGroupId', sql.UniqueIdentifier, userGroupId);
                } else {
                    return res.status(403).json({ success: false, message: 'Access denied: No group assigned' });
                }
            }

            const memberResult = await memberCheckRequest.query(memberCheckQuery);
            if (!memberResult.recordset?.length) {
                return res.status(404).json({ success: false, message: 'Member not found or access denied' });
            }

            const memberRow = memberResult.recordset[0];
            if (memberRow.GroupId) {
                return res.status(400).json({
                    success: false,
                    message: 'Payment methods for group members are managed at group level.',
                });
            }

            let paymentMethodsMemberId = id;
            if (memberRow.HouseholdId) {
                const primaryResult = await pool.request()
                    .input('householdId', sql.UniqueIdentifier, memberRow.HouseholdId)
                    .query(`
                    SELECT MemberId FROM oe.Members
                    WHERE HouseholdId = @householdId AND RelationshipType = 'P'
                `);
                if (primaryResult.recordset?.[0]?.MemberId) {
                    paymentMethodsMemberId = primaryResult.recordset[0].MemberId;
                }
            }

            const pmSel = await pool.request()
                .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
                .input('memberId', sql.UniqueIdentifier, paymentMethodsMemberId)
                .query(`
                SELECT TOP 1 PaymentMethodType, AccountNumberEncrypted, AccountNumberLast4
                FROM oe.MemberPaymentMethods mpm
                WHERE mpm.PaymentMethodId = @paymentMethodId
                  AND mpm.MemberId = @memberId
                  AND mpm.Status IN ${MEMBER_PM_ADMIN_EDITABLE_STATUSES_SQL}
            `);

            if (!pmSel.recordset?.length) {
                return res.status(404).json({
                    success: false,
                    message: 'Payment method not found or access denied',
                });
            }

            const row = pmSel.recordset[0];
            if (String(row.PaymentMethodType || '').toUpperCase() !== 'ACH') {
                return res.status(400).json({
                    success: false,
                    message: 'Decrypted account is only available for bank (ACH) payment methods.',
                });
            }

            if (!row.AccountNumberEncrypted) {
                return res.json({
                    success: true,
                    data: {
                        accountNumber: null,
                        accountNumberLast4: row.AccountNumberLast4 || null,
                        decryptionUnavailable: true,
                    },
                });
            }

            let decrypted = {};
            try {
                decrypted = encryptionService.decryptPaymentData({
                    accountNumberEncrypted: row.AccountNumberEncrypted,
                }) || {};
            } catch (_e) {
                return res.status(500).json({
                    success: false,
                    message: 'Could not decrypt stored account number.',
                });
            }

            const digits =
                decrypted.accountNumber != null
                    ? String(decrypted.accountNumber).replace(/\D/g, '')
                    : '';

            return res.json({
                success: true,
                data: {
                    accountNumber: digits || null,
                    accountNumberLast4: row.AccountNumberLast4 || null,
                    decryptionUnavailable: !digits,
                },
            });
        } catch (error) {
            console.error('❌ Error revealing member ACH account number:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to load account number',
            });
        }
    }
);

/**
 * POST /api/members/:id/payment-methods/:paymentMethodId/add-to-processor
 * Retry syncing an existing locally-saved payment method to DIME.
 */
router.post('/:id/payment-methods/:paymentMethodId/add-to-processor', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), async (req, res) => {
    try {
        const { id, paymentMethodId } = req.params;
        // Admin-provided CVV for vault retry. PCI DSS 3.2.2: passed straight to DIME and
        // never persisted (not logged, not written to DB, not echoed in responses).
        const retryCvvRaw = req.body?.cvv;
        const retryCvv = typeof retryCvvRaw === 'string' ? retryCvvRaw.trim() : null;
        if (retryCvv && !/^\d{3,4}$/.test(retryCvv)) {
            return res.status(400).json({
                success: false,
                message: 'CVV must be 3 or 4 digits.',
                code: 'CVV_INVALID'
            });
        }
        const pool = await getPool();
        const isDimeServerError = (errLike) => {
            const status = Number(
                errLike?.error?.statusCode ??
                errLike?.error?.status ??
                errLike?.statusCode ??
                errLike?.status
            );
            const msg = String(errLike?.error?.message || errLike?.message || '').toLowerCase();
            return status === 500 || msg.includes('server error');
        };

        const memberCheckRequest = pool.request();
        memberCheckRequest.input('memberId', sql.UniqueIdentifier, id);
        let memberCheckQuery = `
            SELECT m.MemberId, m.GroupId, m.HouseholdId, m.ProcessorCustomerId,
                   u.TenantId, u.FirstName, u.LastName, u.Email, u.PhoneNumber,
                   m.Address, m.City, m.State, m.Zip
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `;
        if (req.user.currentRole !== 'SysAdmin') {
            memberCheckQuery += ' AND u.TenantId = @tenantId';
            memberCheckRequest.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        if (req.user.currentRole === 'GroupAdmin') {
            let userGroupId = req.user.GroupId || req.user.groupId;
            if (!userGroupId) {
                const gaResult = await pool.request()
                    .input('userId', sql.UniqueIdentifier, req.user.UserId)
                    .query('SELECT GroupId FROM oe.GroupAdmins WHERE UserId = @userId AND Status = \'Active\'');
                userGroupId = gaResult.recordset?.[0]?.GroupId;
            }
            if (userGroupId) {
                memberCheckQuery += ' AND m.GroupId = @userGroupId';
                memberCheckRequest.input('userGroupId', sql.UniqueIdentifier, userGroupId);
            } else {
                return res.status(403).json({ success: false, message: 'Access denied: No group assigned' });
            }
        }

        const memberResult = await memberCheckRequest.query(memberCheckQuery);
        if (!memberResult.recordset?.length) {
            return res.status(404).json({ success: false, message: 'Member not found or access denied' });
        }

        const memberRow = memberResult.recordset[0];
        if (memberRow.GroupId) {
            return res.status(400).json({
                success: false,
                message: 'Payment methods cannot be synced for group members. Group members use group billing.'
            });
        }

        let paymentMethodsMemberId = id;
        if (memberRow.HouseholdId) {
            const primaryResult = await pool.request()
                .input('householdId', sql.UniqueIdentifier, memberRow.HouseholdId)
                .query(`
                    SELECT m.MemberId, m.ProcessorCustomerId, u.TenantId, u.FirstName, u.LastName, u.Email, u.PhoneNumber, m.Address, m.City, m.State, m.Zip
                    FROM oe.Members m
                    JOIN oe.Users u ON m.UserId = u.UserId
                    WHERE m.HouseholdId = @householdId AND m.RelationshipType = 'P'
                `);
            if (primaryResult.recordset?.[0]) {
                paymentMethodsMemberId = primaryResult.recordset[0].MemberId;
            }
        }

        const primaryResult = await pool.request()
            .input('memberId', sql.UniqueIdentifier, paymentMethodsMemberId)
            .query(`
                SELECT m.MemberId, m.ProcessorCustomerId, u.TenantId, u.FirstName, u.LastName, u.Email, u.PhoneNumber, m.Address, m.City, m.State, m.Zip
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE m.MemberId = @memberId
            `);
        const primary = primaryResult.recordset?.[0];
        if (!primary) {
            return res.status(404).json({ success: false, message: 'Primary member not found' });
        }

        const paymentMethodResult = await pool.request()
            .input('memberId', sql.UniqueIdentifier, paymentMethodsMemberId)
            .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
            .query(`
                SELECT TOP 1
                    PaymentMethodId, PaymentMethodType, IsDefault, CardBrand, CardLast4, ExpiryMonth, ExpiryYear, CardholderName,
                    BankName, AccountType, AccountNumberLast4, AccountHolderName, RoutingNumber,
                    BillingAddress, BillingAddress2, BillingCity, BillingState, BillingZip, BillingCountry,
                    ProcessorToken, ProcessorCustomerId, ProcessorPaymentMethodId,
                    CardNumberEncrypted, AccountNumberEncrypted, RoutingNumberEncrypted
                FROM oe.MemberPaymentMethods
                WHERE MemberId = @memberId
                  AND PaymentMethodId = @paymentMethodId
                  AND Status IN ${MEMBER_PM_ADMIN_EDITABLE_STATUSES_SQL}
            `);
        const existingMethod = paymentMethodResult.recordset?.[0];
        if (!existingMethod) {
            return res.status(404).json({ success: false, message: 'Payment method not found' });
        }

        const forceReplaceProcessorPaymentMethod =
            req.body?.forceReplaceProcessorPaymentMethod === true ||
            req.body?.replaceProcessorPaymentMethod === true;

        if (
            existingMethod.ProcessorCustomerId &&
            existingMethod.ProcessorPaymentMethodId &&
            !forceReplaceProcessorPaymentMethod
        ) {
            return res.json({
                success: true,
                message: 'Payment method is already saved to payment processor.',
                data: {
                    paymentMethodId: existingMethod.PaymentMethodId,
                    processorCustomerId: existingMethod.ProcessorCustomerId,
                    processorPaymentMethodId: existingMethod.ProcessorPaymentMethodId
                }
            });
        }

        let dimeCustomerId = existingMethod.ProcessorCustomerId || primary.ProcessorCustomerId || null;
        const tenantId = primary.TenantId || memberRow.TenantId;

        if (!dimeCustomerId) {
            const byEmail = await DimeService.findCustomerByEmail(primary.Email, tenantId);
            if (byEmail?.success && byEmail.customerId) {
                dimeCustomerId = byEmail.customerId;
            } else {
                const customerResult = await DimeService.createCustomer({
                    firstName: primary.FirstName,
                    lastName: primary.LastName,
                    email: primary.Email,
                    phone: primary.PhoneNumber || '',
                    billingAddress: existingMethod.BillingAddress || primary.Address || '',
                    billingCity: existingMethod.BillingCity || primary.City || '',
                    billingState: existingMethod.BillingState || primary.State || '',
                    billingZip: existingMethod.BillingZip || primary.Zip || '',
                    billingCountry: existingMethod.BillingCountry || 'US'
                }, tenantId);
                if (!customerResult?.success || !customerResult.customerId) {
                    const msg = customerResult?.error?.message || customerResult?.message || 'Failed to create payment processor customer';
                    return res.status(isDimeServerError(customerResult) ? 503 : 400).json({
                        success: false,
                        message: msg
                    });
                }
                dimeCustomerId = customerResult.customerId;
            }
        }

        if (dimeCustomerId) {
            try {
                await pool.request()
                    .input('memberId', sql.UniqueIdentifier, paymentMethodsMemberId)
                    .input('customerId', sql.NVarChar(255), String(dimeCustomerId))
                    .query(`
                        UPDATE oe.Members
                        SET ProcessorCustomerId = @customerId, ModifiedDate = GETUTCDATE()
                        WHERE MemberId = @memberId
                    `);
            } catch (_) {}
        }

        let decrypted = {};
        try {
            decrypted = encryptionService.decryptPaymentData({
                cardNumberEncrypted: existingMethod.CardNumberEncrypted,
                accountNumberEncrypted: existingMethod.AccountNumberEncrypted,
                routingNumberEncrypted: existingMethod.RoutingNumberEncrypted
            }) || {};
        } catch (_) {}

        // PCI DSS 3.2.2: CVV is never persisted. If the first retry fails because DIME requires
        // a CVV for the re-vault, the frontend prompts the admin/member for it and sends it here
        // in the request body — it's passed straight to DIME and dropped on the floor afterwards.
        const paymentMethodType = existingMethod.PaymentMethodType === 'ACH' ? 'ACH' : 'Card';
        const payload = {
            paymentMethodType,
            cardNumber: decrypted.cardNumber || null,
            expiryMonth: existingMethod.ExpiryMonth || null,
            expiryYear: existingMethod.ExpiryYear || null,
            cvv: paymentMethodType === 'Card' ? (retryCvv || undefined) : undefined,
            cardholderName: existingMethod.CardholderName || `${primary.FirstName} ${primary.LastName}`,
            bankName: existingMethod.BankName || null,
            accountType: existingMethod.AccountType || 'Checking',
            routingNumber: resolveAchRoutingForCharge(
                existingMethod.RoutingNumber,
                existingMethod.RoutingNumberEncrypted
            ),
            accountNumber: decrypted.accountNumber || null,
            accountHolderName: existingMethod.AccountHolderName || `${primary.FirstName} ${primary.LastName}`,
            billingAddress: existingMethod.BillingAddress || primary.Address || '',
            billingAddress2: existingMethod.BillingAddress2 || '',
            billingCity: existingMethod.BillingCity || primary.City || '',
            billingState: existingMethod.BillingState || primary.State || '',
            billingZip: existingMethod.BillingZip || primary.Zip || '',
            billingCountry: existingMethod.BillingCountry || 'US'
        };

        if (paymentMethodType === 'Card') {
            if (!payload.cardNumber || !payload.expiryMonth || !payload.expiryYear) {
                return res.status(400).json({
                    success: false,
                    message: 'Stored card details are incomplete for processor sync. Re-add the payment method and try again.'
                });
            }
        } else if (!payload.routingNumber || !payload.accountNumber) {
            return res.status(400).json({
                success: false,
                message: 'Stored bank account details are incomplete for processor sync. Re-add the payment method and try again.'
            });
        }

        const dimeResult = await PaymentMethodService.createPaymentMethod(
            payload,
            dimeCustomerId,
            tenantId,
            { requireTokenization: true }
        );
        if (!dimeResult.success || !dimeResult.paymentMethodId) {
            // DIME / our own client told us the card needs a CVV before it'll re-vault.
            // Signal this specifically so the UI can open a CVV prompt instead of showing
            // a generic failure toast. Check both rawMessage (preferred) and the user-facing
            // message, since cards bouncing with CVV issues can surface either way.
            const errMsg = String(dimeResult.error?.rawMessage || dimeResult.error?.message || '').toLowerCase();
            const needsCvv = paymentMethodType === 'Card'
                && !retryCvv
                && /cvv|cvc|cv2|security code/.test(errMsg);
            if (needsCvv) {
                return res.status(400).json({
                    success: false,
                    code: 'CVV_REQUIRED',
                    message: 'This card requires a CVV to re-save to the payment processor. Please enter the CVV to continue.'
                });
            }
            return res.status(isDimeServerError(dimeResult) ? 503 : 400).json({
                success: false,
                code: dimeResult.error?.code || 'PAYMENT_METHOD_SYNC_FAILED',
                message: dimeResult.error?.message || 'Failed to save payment method to payment processor'
            });
        }

        const actingPmUserId = req.user?.UserId;
        if (!actingPmUserId) {
            return res.status(401).json({ success: false, message: 'User not authenticated' });
        }
        await pool.request()
            .input('paymentMethodId', sql.UniqueIdentifier, existingMethod.PaymentMethodId)
            .input('processorCustomerId', sql.NVarChar(255), String(dimeResult.customerId || dimeCustomerId))
            .input('processorPaymentMethodId', sql.NVarChar(255), String(dimeResult.paymentMethodId))
            .input('processorToken', sql.NVarChar(255), dimeResult.token ? String(dimeResult.token) : null)
            .input('modifiedBy', sql.UniqueIdentifier, actingPmUserId)
            .query(`
                UPDATE oe.MemberPaymentMethods
                SET ProcessorCustomerId = @processorCustomerId,
                    ProcessorPaymentMethodId = @processorPaymentMethodId,
                    ProcessorToken = @processorToken,
                    Status = CASE WHEN Status = 'PendingProcessorVault' THEN 'Active' ELSE Status END,
                    ModifiedDate = GETUTCDATE(),
                    ModifiedBy = @modifiedBy
                WHERE PaymentMethodId = @paymentMethodId
            `);

        const recurringSync = forceReplaceProcessorPaymentMethod && existingMethod.IsDefault && memberRow.HouseholdId
            ? await runPaymentMethodRecurringSync(pool, {
                householdId: memberRow.HouseholdId,
                tenantId,
                paymentMethodId: existingMethod.PaymentMethodId,
                previousProcessorPaymentMethodId: existingMethod.ProcessorPaymentMethodId
                    ? String(existingMethod.ProcessorPaymentMethodId).trim()
                    : null,
                forceRecreate: true,
            })
            : {};

        return res.json({
            success: true,
            message: forceReplaceProcessorPaymentMethod
                ? 'Payment method re-tokenized with payment processor. DIME recurring was updated to use this method when applicable.'
                : 'Payment method saved to payment processor.',
            data: {
                paymentMethodId: existingMethod.PaymentMethodId,
                processorCustomerId: String(dimeResult.customerId || dimeCustomerId),
                processorPaymentMethodId: String(dimeResult.paymentMethodId),
                ...recurringSync,
            }
        });
    } catch (error) {
        console.error('❌ Error syncing member payment method to processor:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to save payment method to payment processor'
        });
    }
});

/**
 * GET /api/members/:id/charge-now-preview
 * Get default charge amount (total premium) for manual charge. Admin access.
 */
router.get('/:id/charge-now-preview', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const { id } = req.params;
        const pool = await getPool();

        const memberCheckRequest = pool.request();
        memberCheckRequest.input('memberId', sql.UniqueIdentifier, id);
        let memberCheckQuery = `
            SELECT m.MemberId, m.GroupId, m.HouseholdId, u.TenantId
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `;
        if (req.user.currentRole !== 'SysAdmin') {
            memberCheckQuery += ' AND u.TenantId = @tenantId';
            memberCheckRequest.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        if (req.user.currentRole === 'GroupAdmin') {
            let userGroupId = req.user.GroupId || req.user.groupId;
            if (!userGroupId) {
                const gaResult = await pool.request()
                    .input('userId', sql.UniqueIdentifier, req.user.UserId)
                    .query('SELECT GroupId FROM oe.GroupAdmins WHERE UserId = @userId AND Status = \'Active\'');
                userGroupId = gaResult.recordset?.[0]?.GroupId;
            }
            if (userGroupId) {
                memberCheckQuery += ' AND m.GroupId = @userGroupId';
                memberCheckRequest.input('userGroupId', sql.UniqueIdentifier, userGroupId);
            } else {
                return res.status(403).json({ success: false, message: 'Access denied: No group assigned' });
            }
        }

        const memberResult = await memberCheckRequest.query(memberCheckQuery);
        if (!memberResult.recordset?.length) {
            return res.status(404).json({ success: false, message: 'Member not found or access denied' });
        }

        const memberRow = memberResult.recordset[0];
        if (memberRow.GroupId) {
            return res.status(400).json({
                success: false,
                message: 'Manual charge is for individual members only. Group members use group billing.'
            });
        }

        const householdId = memberRow.HouseholdId;
        if (!householdId) {
            return res.status(400).json({
                success: false,
                message: 'Member has no household'
            });
        }

        const { buildHouseholdChargeNowPreviewData } = require('../services/householdChargePreview.service');
        const previewData = await buildHouseholdChargeNowPreviewData(pool, householdId);

        return res.json({
            success: true,
            data: previewData
        });
    } catch (error) {
        console.error('❌ Error fetching charge-now preview:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to fetch charge preview'
        });
    }
});

/**
 * POST /api/members/:id/charge-now
 * Manually charge a member. Uses default total premium if amount not provided. Admin access.
 */
router.post('/:id/charge-now', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const actingChargeUserId = req.user?.UserId;
        if (!actingChargeUserId) {
            return res.status(401).json({ success: false, message: 'User not authenticated' });
        }
        const { id } = req.params;
        const { amount, billingPeriodStart, billingPeriodEnd } = req.body || {};
        const pool = await getPool();

        const memberCheckRequest = pool.request();
        memberCheckRequest.input('memberId', sql.UniqueIdentifier, id);
        let memberCheckQuery = `
            SELECT m.MemberId, m.GroupId, m.HouseholdId, m.AgentId, u.TenantId
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
        `;
        if (req.user.currentRole !== 'SysAdmin') {
            memberCheckQuery += ' AND u.TenantId = @tenantId';
            memberCheckRequest.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        if (req.user.currentRole === 'GroupAdmin') {
            let userGroupId = req.user.GroupId || req.user.groupId;
            if (!userGroupId) {
                const gaResult = await pool.request()
                    .input('userId', sql.UniqueIdentifier, req.user.UserId)
                    .query('SELECT GroupId FROM oe.GroupAdmins WHERE UserId = @userId AND Status = \'Active\'');
                userGroupId = gaResult.recordset?.[0]?.GroupId;
            }
            if (userGroupId) {
                memberCheckQuery += ' AND m.GroupId = @userGroupId';
                memberCheckRequest.input('userGroupId', sql.UniqueIdentifier, userGroupId);
            } else {
                return res.status(403).json({ success: false, message: 'Access denied: No group assigned' });
            }
        }

        const memberResult = await memberCheckRequest.query(memberCheckQuery);
        if (!memberResult.recordset?.length) {
            return res.status(404).json({ success: false, message: 'Member not found or access denied' });
        }

        const memberRow = memberResult.recordset[0];
        if (memberRow.GroupId) {
            return res.status(400).json({
                success: false,
                message: 'Manual charge is for individual members only. Group members use group billing.'
            });
        }

        const householdId = memberRow.HouseholdId;
        if (!householdId) {
            return res.status(400).json({
                success: false,
                message: 'Member has no household'
            });
        }

        let chargeAmount = typeof amount === 'number' ? amount : parseFloat(amount);
        if (isNaN(chargeAmount) || chargeAmount <= 0) {
            const premiumResult = await PaymentDatabaseService.getHouseholdTotalPremium(householdId);
            if (!premiumResult.success) {
                return res.status(400).json({
                    success: false,
                    message: 'Could not calculate default premium. Please provide an amount.'
                });
            }
            chargeAmount = Math.round((premiumResult.totalPremium / 100) * 100) / 100;
        }
        chargeAmount = Math.round(chargeAmount * 100) / 100;

        const tenantId = memberRow.TenantId;
        if (!tenantId) {
            return res.status(400).json({
                success: false,
                message: 'Member has no tenant'
            });
        }

        const { executeHouseholdManualCharge } = require('../services/householdManualCharge.service');
        const manualResult = await executeHouseholdManualCharge(pool, {
            householdId,
            tenantId,
            chargeAmount,
            actingUserId: actingChargeUserId,
            fallbackAgentId: memberRow.AgentId,
            billingPeriodStart: billingPeriodStart || null,
            billingPeriodEnd: billingPeriodEnd || null,
            targetInvoiceId: null,
            mode: 'charge-now',
        });
        if (!manualResult.ok) {
            return res.status(manualResult.statusCode).json(manualResult.body);
        }

        return res.json({
            success: true,
            message: 'Payment processed successfully',
            data: manualResult.data,
        });
    } catch (error) {
        console.error('❌ Error processing manual charge:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to process charge'
        });
    }
});

/**
 * GET /api/members/:memberId/pricing
 * Get pricing for a specific member (Admin access)
 * 
 * Query Parameters:
 * - memberAge: number (required)
 * - tobaccoUse: string (required)
 * - memberTier: string (required) - EE, ES, EC, EF
 * - selectedProducts: string[] (required) - Array of product IDs
 * - productConfigs: object (required) - Product configuration data
 */
router.get('/:memberId/pricing', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner']), async (req, res) => {
    try {
        const { memberId } = req.params;
        const { memberAge, tobaccoUse, memberTier, selectedProducts, productConfigs } = req.query;
        
        // Validate required parameters
        if (!memberAge || !tobaccoUse || !memberTier || !selectedProducts || !productConfigs) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameters: memberAge, tobaccoUse, memberTier, selectedProducts, productConfigs'
            });
        }
        
        // Parse JSON parameters
        let parsedSelectedProducts;
        let parsedProductConfigs;
        
        try {
            parsedSelectedProducts = JSON.parse(selectedProducts);
            parsedProductConfigs = JSON.parse(productConfigs);
        } catch (parseError) {
            return res.status(400).json({
                success: false,
                message: 'Invalid JSON format for selectedProducts or productConfigs'
            });
        }
        
        // Calculate pricing using new unified PricingEngine
        const pricingParams = {
            calculationType: 'enrollment',
            memberCriteria: {
                age: parseInt(memberAge),
                tobaccoUse: tobaccoUse,
                tier: memberTier,
                householdSize: 1 // Default, could be calculated from member data
            },
            productSelections: parsedSelectedProducts.map(productId => ({
                productId,
                configValues: parsedProductConfigs[productId] || {}
            }))
        };
        
        const pricingResult = await PricingEngine.calculatePricing(pricingParams);
        
        // Calculate next billing cycle date (simplified for now)
        const currentEffectiveDate = new Date().toISOString().split('T')[0]; // Default to today
        const nextBillingCycleDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // 30 days from now
        
        res.json({
            success: true,
            data: {
                ...pricingResult,
                currentEffectiveDate: currentEffectiveDate,
                nextBillingCycleDate: nextBillingCycleDate,
                calculatedAt: new Date().toISOString(),
                requestedBy: req.user.UserId,
                requestedByRoles: getUserRoles(req.user)
            }
        });
        
    } catch (error) {
        console.error('❌ Error in /api/members/:memberId/pricing:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while calculating member pricing',
            error: {
                message: error.message,
                code: 'ADMIN_MEMBER_PRICING_ERROR'
            }
        });
    }
});

/**
 * GET /api/members/:memberId/products
 * Get available products for a specific member (Admin/Agent/GroupAdmin access)
 * Uses shared MemberProductsService for consistency
 */
router.get('/:memberId/products', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), async (req, res) => {
    try {
        const { memberId } = req.params;
        const userTenantId = req.user.TenantId;
        const pool = await getPool();

        console.log(`🔍 GET /api/members/${memberId}/products - Admin fetching products for member`);

        // For GroupAdmin: Verify member belongs to their group
        if (req.user.currentRole === 'GroupAdmin') {
            // Get GroupAdmin's group ID
            let userGroupId = req.user.GroupId || req.user.groupId;
            
            // If GroupId not in JWT, query from GroupAdmins table
            if (!userGroupId) {
                const groupIdQuery = `
                    SELECT GroupId 
                    FROM oe.GroupAdmins 
                    WHERE UserId = @userId AND Status = 'Active'
                `;
                const groupIdRequest = pool.request();
                groupIdRequest.input('userId', sql.UniqueIdentifier, req.user.UserId);
                const groupIdResult = await groupIdRequest.query(groupIdQuery);
                
                if (groupIdResult.recordset.length > 0 && groupIdResult.recordset[0].GroupId) {
                    userGroupId = groupIdResult.recordset[0].GroupId;
                }
            }
            
            if (userGroupId) {
                // Verify member belongs to GroupAdmin's group
                const memberCheckRequest = pool.request();
                memberCheckRequest.input('memberId', sql.UniqueIdentifier, memberId);
                memberCheckRequest.input('userGroupId', sql.UniqueIdentifier, userGroupId);
                const memberCheckResult = await memberCheckRequest.query(`
                    SELECT MemberId, GroupId 
                    FROM oe.Members 
                    WHERE MemberId = @memberId AND GroupId = @userGroupId
                `);
                
                if (memberCheckResult.recordset.length === 0) {
                    return res.status(403).json({
                        success: false,
                        message: 'Access denied: Member does not belong to your group'
                    });
                }
            } else {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied: No group assigned',
                    code: 'NO_GROUP_ASSIGNED'
                });
            }
        }

        // Use shared service for consistency
        const products = await MemberProductsService.getAvailableProducts(memberId, userTenantId);

        res.json({
            success: true,
            data: products
        });

    } catch (error) {
        console.error('❌ Error in /api/members/:memberId/products:', error);
        
        if (error.message.includes('not found')) {
            return res.status(404).json({
                success: false,
                message: 'Member not found or access denied'
            });
        }

        if (error.message.includes('Access denied')) {
            return res.status(403).json({
                success: false,
                message: error.message
            });
        }

        res.status(500).json({
            success: false,
            message: 'Server error while fetching products',
            error: {
                message: error.message,
                code: 'ADMIN_MEMBER_PRODUCTS_ERROR'
            }
        });
    }
});

/**
 * GET /api/members/:memberId/enrollments
 * Get enrollments for a specific member (Admin/Agent/GroupAdmin access)
 * Uses shared MemberProductsService for consistency
 */
router.get('/:memberId/enrollments', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), async (req, res) => {
    try {
        const { memberId } = req.params;
        const userTenantId = req.user.TenantId;
        const pool = await getPool();

        console.log(`🔍 GET /api/members/${memberId}/enrollments - Admin fetching enrollments for member`);

        // For GroupAdmin: Verify member belongs to their group
        if (req.user.currentRole === 'GroupAdmin') {
            // Get GroupAdmin's group ID
            let userGroupId = req.user.GroupId || req.user.groupId;
            
            // If GroupId not in JWT, query from GroupAdmins table
            if (!userGroupId) {
                const groupIdQuery = `
                    SELECT GroupId 
                    FROM oe.GroupAdmins 
                    WHERE UserId = @userId AND Status = 'Active'
                `;
                const groupIdRequest = pool.request();
                groupIdRequest.input('userId', sql.UniqueIdentifier, req.user.UserId);
                const groupIdResult = await groupIdRequest.query(groupIdQuery);
                
                if (groupIdResult.recordset.length > 0 && groupIdResult.recordset[0].GroupId) {
                    userGroupId = groupIdResult.recordset[0].GroupId;
                }
            }
            
            if (userGroupId) {
                // Verify member belongs to GroupAdmin's group
                const memberCheckRequest = pool.request();
                memberCheckRequest.input('memberId', sql.UniqueIdentifier, memberId);
                memberCheckRequest.input('userGroupId', sql.UniqueIdentifier, userGroupId);
                const memberCheckResult = await memberCheckRequest.query(`
                    SELECT MemberId, GroupId 
                    FROM oe.Members 
                    WHERE MemberId = @memberId AND GroupId = @userGroupId
                `);
                
                if (memberCheckResult.recordset.length === 0) {
                    return res.status(403).json({
                        success: false,
                        message: 'Access denied: Member does not belong to your group'
                    });
                }
            } else {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied: No group assigned',
                    code: 'NO_GROUP_ASSIGNED'
                });
            }
        }

        // Use shared service for consistency
        const enrollments = await MemberProductsService.getMemberEnrollments(memberId, userTenantId);

        res.json({
            success: true,
            data: enrollments
        });

    } catch (error) {
        console.error('❌ Error in /api/members/:memberId/enrollments:', error);
        
        if (error.message.includes('not found')) {
            return res.status(404).json({
                success: false,
                message: 'Member not found or access denied'
            });
        }

        if (error.message.includes('Access denied')) {
            return res.status(403).json({
                success: false,
                message: error.message
            });
        }

        res.status(500).json({
            success: false,
            message: 'Server error while fetching enrollments',
            error: {
                message: error.message,
                code: 'ADMIN_MEMBER_ENROLLMENTS_ERROR'
            }
        });
    }
});

/**
 * GET /api/members/:memberId/profile
 * Get member profile for a specific member (Admin/Agent/GroupAdmin access)
 * Uses shared MemberProductsService for consistency
 */
router.get('/:memberId/profile', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), async (req, res) => {
    try {
        const { memberId } = req.params;
        const userTenantId = req.user.TenantId;
        const pool = await getPool();

        console.log(`🔍 GET /api/members/${memberId}/profile - Admin fetching profile for member`);

        // For GroupAdmin: Verify member belongs to their group
        if (req.user.currentRole === 'GroupAdmin') {
            // Get GroupAdmin's group ID
            let userGroupId = req.user.GroupId || req.user.groupId;
            
            // If GroupId not in JWT, query from GroupAdmins table
            if (!userGroupId) {
                const groupIdQuery = `
                    SELECT GroupId 
                    FROM oe.GroupAdmins 
                    WHERE UserId = @userId AND Status = 'Active'
                `;
                const groupIdRequest = pool.request();
                groupIdRequest.input('userId', sql.UniqueIdentifier, req.user.UserId);
                const groupIdResult = await groupIdRequest.query(groupIdQuery);
                
                if (groupIdResult.recordset.length > 0 && groupIdResult.recordset[0].GroupId) {
                    userGroupId = groupIdResult.recordset[0].GroupId;
                }
            }
            
            if (userGroupId) {
                // Verify member belongs to GroupAdmin's group
                const memberCheckRequest = pool.request();
                memberCheckRequest.input('memberId', sql.UniqueIdentifier, memberId);
                memberCheckRequest.input('userGroupId', sql.UniqueIdentifier, userGroupId);
                const memberCheckResult = await memberCheckRequest.query(`
                    SELECT MemberId, GroupId 
                    FROM oe.Members 
                    WHERE MemberId = @memberId AND GroupId = @userGroupId
                `);
                
                if (memberCheckResult.recordset.length === 0) {
                    return res.status(403).json({
                        success: false,
                        message: 'Access denied: Member does not belong to your group'
                    });
                }
            } else {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied: No group assigned',
                    code: 'NO_GROUP_ASSIGNED'
                });
            }
        }

        // Use shared service for consistency
        const profile = await MemberProductsService.getMemberProfile(memberId, userTenantId);

        res.json({
            success: true,
            data: profile
        });

    } catch (error) {
        console.error('❌ Error in /api/members/:memberId/profile:', error);
        
        if (error.message.includes('not found')) {
            return res.status(404).json({
                success: false,
                message: 'Member not found or access denied'
            });
        }

        if (error.message.includes('Access denied')) {
            return res.status(403).json({
                success: false,
                message: error.message
            });
        }

        res.status(500).json({
            success: false,
            message: 'Server error while fetching profile',
            error: {
                message: error.message,
                code: 'ADMIN_MEMBER_PROFILE_ERROR'
            }
        });
    }
});

// POST Household (Primary + Dependents) - Atomic creation
// Creates entire household in a single transaction - rolls back if any member fails
router.post('/household', authorize(['Admin','SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), async (req, res) => {
    try {
        const { primaryMember, dependents = [] } = req.body;

        // Validate primary member
        if (!primaryMember || !primaryMember.firstName || !primaryMember.lastName || !primaryMember.email) {
            return res.status(400).json({
                success: false,
                message: 'Primary member requires first name, last name, and email'
            });
        }

        // Validate dependents
        for (let i = 0; i < dependents.length; i++) {
            const dep = dependents[i];
            if (!dep.firstName || !dep.lastName) {
                return res.status(400).json({
                    success: false,
                    message: `Dependent ${i + 1} requires first name and last name`
                });
            }
        }

        const pool = await getPool();
        const transaction = pool.transaction();
        await transaction.begin();

        try {
            let householdId = require('crypto').randomUUID();
            const createdMembers = [];
            const createdUsers = [];
            let tenantId = req.user.TenantId;
            let groupId = primaryMember.groupId || null;
            let agentId = primaryMember.agentId || null;

            // Get tenant from group if groupId provided
            if (groupId) {
                const groupRequest = transaction.request();
                groupRequest.input('groupId', sql.UniqueIdentifier, groupId);
                const groupResult = await groupRequest.query('SELECT TenantId, AgentId FROM oe.Groups WHERE GroupId = @groupId');
                if (groupResult.recordset.length > 0) {
                    tenantId = groupResult.recordset[0].TenantId;
                    if (!agentId && groupResult.recordset[0].AgentId) {
                        agentId = groupResult.recordset[0].AgentId;
                    }
                }
            }

            // Determine agent (frontend-specified > group agent > creator agent)
            if (!agentId) {
                const userRoles = getUserRoles(req.user);
                if (userRoles.includes('Agent')) {
                    const creatorAgentRequest = transaction.request();
                    creatorAgentRequest.input('creatorUserId', sql.UniqueIdentifier, req.user.UserId);
                    const creatorAgentResult = await creatorAgentRequest.query(`
                        SELECT AgentId FROM oe.Agents WHERE UserId = @creatorUserId
                    `);
                    if (creatorAgentResult.recordset.length > 0) {
                        agentId = creatorAgentResult.recordset[0].AgentId;
                    }
                }
            }

            // Check if primary member already exists in this group
            let existingPrimaryMember = null;
            if (primaryMember.email && !primaryMember.email.includes('@noemail.com')) {
                const primaryCheckRequest = transaction.request();
                primaryCheckRequest.input('email', sql.NVarChar, primaryMember.email);
                primaryCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
                const primaryCheckResult = await primaryCheckRequest.query(`
                    SELECT u.UserId, m.MemberId, m.HouseholdId, m.RelationshipType
                    FROM oe.Users u
                    INNER JOIN oe.Members m ON u.UserId = m.UserId
                    WHERE u.Email = @email AND m.GroupId = @groupId
                      AND (m.RelationshipType = 'P' OR m.RelationshipType IS NULL)
                `);

                if (primaryCheckResult.recordset.length > 0) {
                    existingPrimaryMember = primaryCheckResult.recordset[0];
                    console.log(`ℹ️ Primary member already exists in this group, will use existing: ${primaryMember.email}`);
                }
            }

            // Helper function to create a member
            const createMemberInTransaction = async (memberData, isPrimary) => {
                const userId = require('crypto').randomUUID();
                const memberId = require('crypto').randomUUID();
                let email = memberData.email;
                let memberUserId = userId;
                let linkedExistingUser = false;

                // Generate default email for dependents if not provided
                if (!isPrimary && (!email || email.trim() === '')) {
                    email = `dependent-${userId}@noemail.com`;
                }

                // Check for existing user (skip for generated dependent emails)
                if (email && !email.includes('@noemail.com')) {
                    const emailCheckRequest = transaction.request();
                    emailCheckRequest.input('email', sql.NVarChar, email);
                    const emailCheckResult = await emailCheckRequest.query(`
                        SELECT u.UserId, u.FirstName, u.LastName, u.PhoneNumber, u.Email,
                               m.MemberId, m.GroupId, m.HouseholdId, m.RelationshipType
                        FROM oe.Users u
                        LEFT JOIN oe.Members m ON u.UserId = m.UserId
                        WHERE u.Email = @email
                    `);

                    if (emailCheckResult.recordset.length > 0) {
                        const existingUser = emailCheckResult.recordset[0];
                        
                        // Check if already in this group
                        if (existingUser.MemberId && existingUser.GroupId && groupId && 
                            existingUser.GroupId.toString() === groupId) {
                            throw new Error(`Member with email ${email} already exists in this group`);
                        }
                        
                        // User exists but not in this group - link and create oe.Members record
                        // This allows existing oe.Users to be added as members to this group
                        console.log(`✅ Linking existing user to new member in household import: ${existingUser.FirstName} ${existingUser.LastName} (${email})`);
                        memberUserId = existingUser.UserId;
                        linkedExistingUser = true;
                        
                        // Form data takes precedence - use form data if provided, otherwise fall back to existing user data
                        memberData.firstName = (memberData.firstName && memberData.firstName.trim()) ? memberData.firstName.trim() : existingUser.FirstName;
                        memberData.lastName = (memberData.lastName && memberData.lastName.trim()) ? memberData.lastName.trim() : existingUser.LastName;
                        email = existingUser.Email;
                        memberData.phoneNumber = (memberData.phoneNumber && memberData.phoneNumber.trim()) ? memberData.phoneNumber : (memberData.phone && memberData.phone.trim()) ? memberData.phone : existingUser.PhoneNumber;
                    }
                }

                // Create User record only if not linking to existing user
                if (!linkedExistingUser) {
                    const userRequest = transaction.request();
                    userRequest.input('userId', sql.UniqueIdentifier, memberUserId);
                    userRequest.input('firstName', sql.NVarChar, memberData.firstName);
                    userRequest.input('lastName', sql.NVarChar, memberData.lastName);
                    userRequest.input('email', sql.NVarChar, email);
                    userRequest.input('phoneNumber', sql.NVarChar, memberData.phoneNumber || memberData.phone || null);
                    userRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
                    userRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);

                    await userRequest.query(`
                        INSERT INTO oe.Users 
                        (UserId, FirstName, LastName, Email, PhoneNumber, TenantId, Status, 
                         CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                        VALUES 
                        (@userId, @firstName, @lastName, @email, @phoneNumber, @tenantId, 'Pending',
                         GETDATE(), GETDATE(), @createdBy, @createdBy)
                    `);

                    createdUsers.push({ userId: memberUserId, email });
                }

                // Get member sequence
                const seqRequest = transaction.request();
                seqRequest.input('householdId', sql.UniqueIdentifier, householdId);
                const seqResult = await seqRequest.query(`
                    SELECT ISNULL(MAX(MemberSequence), 0) + 1 as NextSequence 
                    FROM oe.Members 
                    WHERE HouseholdId = @householdId
                `);
                const memberSequence = seqResult.recordset[0].NextSequence;

                let relType = 'P';
                if (!isPrimary) {
                    const raw = memberData.relationshipType == null ? '' : String(memberData.relationshipType).trim().toUpperCase();
                    relType = raw === 'S' || raw === 'C' ? raw : 'C';
                }

                // Create Member record
                const memberRequest = transaction.request();
                memberRequest.input('memberId', sql.UniqueIdentifier, memberId);
                memberRequest.input('userId', sql.UniqueIdentifier, memberUserId);
                memberRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
                memberRequest.input('groupId', sql.UniqueIdentifier, groupId);
                memberRequest.input('agentId', sql.UniqueIdentifier, agentId);
                memberRequest.input('householdId', sql.UniqueIdentifier, householdId);
                memberRequest.input('memberSequence', sql.Int, memberSequence);
                memberRequest.input('relationshipType', sql.NVarChar, relType);
                memberRequest.input('dateOfBirth', sql.Date, memberData.dateOfBirth || null);
                memberRequest.input('gender', sql.NVarChar, memberData.gender || null);
                memberRequest.input('address', sql.NVarChar, memberData.address || null);
                memberRequest.input('city', sql.NVarChar, memberData.city || null);
                memberRequest.input('state', sql.NVarChar, memberData.state || null);
                memberRequest.input('zip', sql.NVarChar, memberData.zip || null);
                memberRequest.input('workLocation', sql.NVarChar, memberData.workLocation || null);
                memberRequest.input('locationId', sql.UniqueIdentifier, memberData.locationId || null);
                memberRequest.input('jobPosition', sql.NVarChar(50), memberData.jobPosition || null);
                memberRequest.input('hireDate', sql.Date, memberData.hireDate || null);
                memberRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);

                await memberRequest.query(`
                    INSERT INTO oe.Members 
                    (MemberId, UserId, TenantId, GroupId, AgentId, HouseholdId, MemberSequence, 
                     RelationshipType, Status, DateOfBirth, Gender, Address, City, State, Zip,
                     WorkLocation, LocationId, JobPosition, HireDate, EnrollmentType, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                    VALUES 
                    (@memberId, @userId, @tenantId, @groupId, @agentId, @householdId, @memberSequence,
                     @relationshipType, 'Active', @dateOfBirth, @gender, @address, @city, @state, @zip,
                     @workLocation, @locationId, @jobPosition, @hireDate, 'Standard', GETDATE(), GETDATE(), @createdBy, @createdBy)
                `);

                // Generate HouseholdMemberID
                const householdMemberIdRequest = transaction.request();
                householdMemberIdRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
                householdMemberIdRequest.input('MemberId', sql.UniqueIdentifier, memberId);
                householdMemberIdRequest.output('HouseholdMemberID', sql.NVarChar(50));
                
                await householdMemberIdRequest.execute('oe.GenerateHouseholdMemberID');
                const generatedHouseholdMemberID = householdMemberIdRequest.parameters.HouseholdMemberID.value;
                
                const updateHouseholdIdRequest = transaction.request();
                updateHouseholdIdRequest.input('memberId', sql.UniqueIdentifier, memberId);
                updateHouseholdIdRequest.input('householdMemberID', sql.NVarChar(50), generatedHouseholdMemberID);
                
                await updateHouseholdIdRequest.query(`
                    UPDATE oe.Members 
                    SET HouseholdMemberID = @householdMemberID, ModifiedDate = GETDATE()
                    WHERE MemberId = @memberId
                `);

                return { memberId, userId: memberUserId, email };
            };

            // Handle primary member (create new or use existing)
            let primaryResult;
            if (existingPrimaryMember) {
                // Use existing primary member
                primaryResult = {
                    memberId: existingPrimaryMember.MemberId,
                    userId: existingPrimaryMember.UserId,
                    email: primaryMember.email
                };
                // Update householdId to use existing primary's household
                const existingHouseholdRequest = transaction.request();
                existingHouseholdRequest.input('memberId', sql.UniqueIdentifier, existingPrimaryMember.MemberId);
                const existingHouseholdResult = await existingHouseholdRequest.query(`
                    SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId
                `);
                if (existingHouseholdResult.recordset.length > 0) {
                    // Use existing household ID instead of creating new one
                    const existingHouseholdId = existingHouseholdResult.recordset[0].HouseholdId;
                    // Update the householdId variable for dependents
                    const updateHouseholdRequest = transaction.request();
                    updateHouseholdRequest.input('newHouseholdId', sql.UniqueIdentifier, existingHouseholdId);
                    updateHouseholdRequest.input('oldHouseholdId', sql.UniqueIdentifier, householdId);
                    // We'll use the existing household ID for dependents
                    householdId = existingHouseholdId;
                }
                console.log(`ℹ️ Using existing primary member: ${primaryMember.firstName} ${primaryMember.lastName}`);
            } else {
                // Create new primary member
                console.log(`🏠 Creating household atomically: Primary: ${primaryMember.firstName} ${primaryMember.lastName}, Dependents: ${dependents.length}`);
                primaryResult = await createMemberInTransaction(primaryMember, true);
            }
            createdMembers.push(primaryResult);

            // Create all dependents
            for (let i = 0; i < dependents.length; i++) {
                const dependent = dependents[i];
                console.log(`  Creating dependent ${i + 1}/${dependents.length}: ${dependent.firstName} ${dependent.lastName}`);
                const dependentResult = await createMemberInTransaction(dependent, false);
                createdMembers.push(dependentResult);
            }

            // Member portal auth uses oe.UserRoles — same transaction so household is never committed without roles
            for (const member of createdMembers) {
                await UserRolesService.assignRoleToUser(member.userId, 'Member', req.user.UserId, transaction);
            }

            // Commit transaction - all members created successfully
            await transaction.commit();
            console.log(`✅ Transaction committed successfully for household: ${primaryMember.firstName} ${primaryMember.lastName}`);

            // Verify members were actually created
            const verifyRequest = pool.request();
            verifyRequest.input('groupId', sql.UniqueIdentifier, groupId);
            verifyRequest.input('householdId', sql.UniqueIdentifier, householdId);
            const verifyResult = await verifyRequest.query(`
                SELECT COUNT(*) as MemberCount 
                FROM oe.Members 
                WHERE HouseholdId = @householdId AND GroupId = @groupId
            `);
            const actualCount = verifyResult.recordset[0].MemberCount;
            console.log(`🔍 Verification: Household ${householdId} has ${actualCount} member(s) in database`);

            res.status(201).json({
                success: true,
                message: `Household created successfully with ${createdMembers.length} member(s)`,
                data: {
                    householdId: householdId,
                    primaryMemberId: createdMembers[0].memberId,
                    members: createdMembers.map(m => ({
                        memberId: m.memberId,
                        userId: m.userId,
                        email: m.email
                    })),
                    verifiedCount: actualCount
                }
            });

        } catch (error) {
            await transaction.rollback();
            console.error('❌ Error creating household atomically:', error);
            throw error;
        }

    } catch (error) {
        console.error('❌ Error in household creation endpoint:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to create household',
            error: {
                message: error.message,
                code: 'HOUSEHOLD_CREATION_ERROR'
            }
        });
    }
});

module.exports = router;