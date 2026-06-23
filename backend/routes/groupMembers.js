const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize } = require('../middleware/auth');
const logger = require('../config/logger');
const { MEMBER_LIST_ENROLLMENT_LINK_SENT_AT_SQL } = require('../utils/memberEnrollmentStatusSql');

/** Virtual "all products" Contribution enrollment rows use this ProductId */
const ALL_PRODUCTS_CONTRIBUTION_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * Employer share aggregated at household scope. Avoids double-counting when both Contribution rows
 * and Product rows persist EmployerContributionAmount for the same rules.
 *
 * @param {{ effectiveCmp: string, terminationCmp?: string, reportMonthEnd?: boolean }} predicates
 */
/** Enrollment active on the last calendar day of a monthly report (date-based; includes May 31 term on May report). */
function reportMonthTerminationActiveSql(alias) {
    return `(${alias}.TerminationDate IS NULL OR CAST(${alias}.TerminationDate AS DATE) >= @ReportMonthEndDate)`;
}

function householdEmployerContributionCaseSql(predicates) {
    const { effectiveCmp, terminationCmp, reportMonthEnd } = predicates;
    const termActive = (alias) => (reportMonthEnd
        ? reportMonthTerminationActiveSql(alias)
        : `(${alias}.TerminationDate IS NULL OR ${alias}.TerminationDate ${terminationCmp})`);
    const G = ALL_PRODUCTS_CONTRIBUTION_GUID;
    return `
CASE
  WHEN EXISTS (
    SELECT 1 FROM oe.Enrollments ex
    INNER JOIN oe.Members hmx ON ex.MemberId = hmx.MemberId
    WHERE hmx.HouseholdId = m.HouseholdId
      AND ex.EffectiveDate ${effectiveCmp}
      AND ${termActive('ex')}
      AND ex.EnrollmentType = 'Contribution'
      AND ex.ProductId <> '${G}'
  ) THEN ISNULL((
    SELECT SUM(e.EmployerContributionAmount)
    FROM oe.Enrollments e
    INNER JOIN oe.Members hm ON e.MemberId = hm.MemberId
    WHERE hm.HouseholdId = m.HouseholdId
      AND e.EffectiveDate ${effectiveCmp}
      AND ${termActive('e')}
      AND e.EnrollmentType = 'Contribution'
      AND e.ProductId <> '${G}'
  ), 0)
  WHEN EXISTS (
    SELECT 1 FROM oe.Enrollments ex
    INNER JOIN oe.Members hmx ON ex.MemberId = hmx.MemberId
    WHERE hmx.HouseholdId = m.HouseholdId
      AND ex.EffectiveDate ${effectiveCmp}
      AND ${termActive('ex')}
      AND ex.EnrollmentType = 'Contribution'
      AND ex.ProductId = '${G}'
  ) THEN ISNULL((
    SELECT SUM(e.EmployerContributionAmount)
    FROM oe.Enrollments e
    INNER JOIN oe.Members hm ON e.MemberId = hm.MemberId
    WHERE hm.HouseholdId = m.HouseholdId
      AND e.EffectiveDate ${effectiveCmp}
      AND ${termActive('e')}
      AND e.EnrollmentType = 'Contribution'
      AND e.ProductId = '${G}'
  ), 0)
  ELSE ISNULL((
    SELECT SUM(e.EmployerContributionAmount)
    FROM oe.Enrollments e
    INNER JOIN oe.Members hm ON e.MemberId = hm.MemberId
    WHERE hm.HouseholdId = m.HouseholdId
      AND e.EffectiveDate ${effectiveCmp}
      AND ${termActive('e')}
      AND (
        e.EnrollmentType IS NULL
        OR e.EnrollmentType IN ('Product', 'PaymentProcessingFee', 'ProcessingFee', 'SystemFee')
      )
  ), 0)
END`;

}

/** Primary rows on group roster: explicit P or legacy NULL (dependents are always S/C). */
const GROUP_ROSTER_PRIMARY_SQL = "(m.RelationshipType = 'P' OR m.RelationshipType IS NULL)";

/**
 * @route   GET /api/groups/:groupId/members
 * @desc    Get all members for a specific group with pagination and sorting
 * @access  Private (All roles with appropriate tenant access)
 * @query   page, pageSize, sortBy, sortOrder, locationFilter, showTerminated, showInactive, search
 */
router.get('/:groupId/members', authorize(['SysAdmin', 'TenantAdmin', 'GroupAdmin', 'Agent']), async (req, res) => {
    const { groupId } = req.params;
    const { 
        page = 1, 
        pageSize = 10, 
        sortBy = 'LastName', 
        sortOrder = 'asc',
        locationFilter = 'all',
        showTerminated = 'false',  // Default to false, but frontend should control this
        showInactive = 'false',    // Hide soft-deleted (Status Inactive) unless explicitly requested
        search,
        enrollmentStatusFilter = 'all'
    } = req.query;
    
    logger.info(`[GROUP-MEMBERS-ROUTE] Request to get members for group ID: ${groupId} (page: ${page}, pageSize: ${pageSize}, sortBy: ${sortBy}, sortOrder: ${sortOrder})`);
    console.log(`[GROUP-MEMBERS-ROUTE] Request to get members for group ID: ${groupId} (page: ${page}, pageSize: ${pageSize}, sortBy: ${sortBy}, sortOrder: ${sortOrder})`);

    try {
        const pool = await getPool();
        console.log('[GROUP-MEMBERS-ROUTE] Pool acquired');
        
        // Build WHERE clause for filters
        let whereClause = `m.GroupId = @GroupId AND ${GROUP_ROSTER_PRIMARY_SQL}`;
        
        // Exclude terminated members when showTerminated is false (server-side so search, filters, and pagination are correct)
        if (showTerminated !== 'true') {
            whereClause += " AND m.Status != 'Terminated'";
        }
        // Exclude inactive (soft-removed) members by default — same roster semantics as "removed" in member edit
        if (showInactive !== 'true') {
            whereClause += " AND m.Status != 'Inactive'";
        }
        
        // Location filter
        if (locationFilter !== 'all') {
            whereClause += ' AND m.LocationId = @LocationId';
        }
        
        // Search filter - search by first name, last name, full name, email, or phone
        if (search && search.trim()) {
            whereClause += ' AND (u.FirstName LIKE @Search OR u.LastName LIKE @Search OR (u.FirstName + \' \' + u.LastName) LIKE @Search OR u.Email LIKE @Search OR u.PhoneNumber LIKE @Search)';
        }
        
        // Enrollment status filter (current or future effective = enrolled)
        const hasCurrentOrFutureEnrollment = `EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending') AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE())))`;
        if (enrollmentStatusFilter !== 'all') {
            // Add enrollment status filter using the same CASE logic as in the SELECT
            const statusConditions = {
                'Pending Login': `${hasCurrentOrFutureEnrollment} AND u.PasswordHash IS NULL`,
                'Enrolled': hasCurrentOrFutureEnrollment,
                'Enrolled (including Pending Login)': hasCurrentOrFutureEnrollment,
                'Pending Approval': `EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Pending')`,
                'Declined Coverage': `EXISTS (SELECT 1 FROM oe.DeclineAcknowledgements da WHERE da.MemberId = m.MemberId AND da.Status = 'Active')`,
                'Terminated': `(m.Status = 'Terminated' OR (EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId) AND NOT (${hasCurrentOrFutureEnrollment}) AND NOT EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Pending')))`,
                'Enrollment Link Sent': `EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount = 0 AND el.IsActive = 1 AND (el.ExpiresAt IS NULL OR el.ExpiresAt > GETUTCDATE()))
                    AND NOT (${hasCurrentOrFutureEnrollment})`,
                'Enrollment Link Used': `EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount > 0 AND el.IsActive = 1)`,
                'Not Enrolled': `NOT (${hasCurrentOrFutureEnrollment})
                    AND NOT EXISTS (SELECT 1 FROM oe.DeclineAcknowledgements da WHERE da.MemberId = m.MemberId AND da.Status = 'Active')
                    AND NOT EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.IsActive = 1)`
            };
            
            if (statusConditions[enrollmentStatusFilter]) {
                whereClause += ` AND ${statusConditions[enrollmentStatusFilter]}`;
            }
        }
        
        // Build ORDER BY clause (MonthlyPremium now sortable via SQL function!)
        const validSortFields = {
            'LastName': 'u.LastName',
            'FirstName': 'u.FirstName',
            'Email': 'u.Email',
            'LocationName': 'gl.Name',
            'MonthlyPremium': 'MonthlyPremium',
            'CreatedDate': 'm.CreatedDate',
            'EnrollmentStatus': 'EnrollmentStatusPriority, EnrollmentStatus' // Custom sorting for enrollment status
        };
        
        // For EnrollmentStatus, use custom priority-based sorting
        let sortField = validSortFields[sortBy] || 'u.LastName';
        const sortDirection = sortOrder.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        
        // Special handling for EnrollmentStatus sorting
        if (sortBy === 'EnrollmentStatus') {
            // Sort by priority first (Not Enrolled = 1, Enrolled = 2), then by status name
            // ASC: Not Enrolled (priority 1) first, then enrolled statuses (priority 2)
            // DESC: Enrolled statuses (priority 2) first, then Not Enrolled (priority 1)
            sortField = `EnrollmentStatusPriority ${sortDirection}, EnrollmentStatus`;
        }
        
        // Calculate pagination
        const pageNum = parseInt(page, 10);
        const pageSizeNum = parseInt(pageSize, 10);
        const offset = (pageNum - 1) * pageSizeNum;
        
        // Get total count for pagination
        const countRequest = pool.request().input('GroupId', sql.UniqueIdentifier, groupId);
        if (locationFilter !== 'all') {
            countRequest.input('LocationId', sql.UniqueIdentifier, locationFilter);
        }
        if (search && search.trim()) {
            countRequest.input('Search', sql.NVarChar, `%${search.trim()}%`);
        }
        
        // Need to join Users table for search in count query
        let countWhereClause = `m.GroupId = @GroupId AND ${GROUP_ROSTER_PRIMARY_SQL}`;
        if (showTerminated !== 'true') {
            countWhereClause += " AND m.Status != 'Terminated'";
        }
        if (showInactive !== 'true') {
            countWhereClause += " AND m.Status != 'Inactive'";
        }
        if (locationFilter !== 'all') {
            countWhereClause += ' AND m.LocationId = @LocationId';
        }
        if (search && search.trim()) {
            countWhereClause += ' AND (u.FirstName LIKE @Search OR u.LastName LIKE @Search OR (u.FirstName + \' \' + u.LastName) LIKE @Search OR u.Email LIKE @Search OR u.PhoneNumber LIKE @Search)';
        }
        if (enrollmentStatusFilter !== 'all') {
            const countStatusConditions = {
                'Pending Login': `${hasCurrentOrFutureEnrollment} AND u.PasswordHash IS NULL`,
                'Enrolled': hasCurrentOrFutureEnrollment,
                'Enrolled (including Pending Login)': hasCurrentOrFutureEnrollment,
                'Pending Approval': `EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Pending')`,
                'Declined Coverage': `EXISTS (SELECT 1 FROM oe.DeclineAcknowledgements da WHERE da.MemberId = m.MemberId AND da.Status = 'Active')`,
                'Terminated': `(m.Status = 'Terminated' OR (EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId) AND NOT (${hasCurrentOrFutureEnrollment}) AND NOT EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Pending')))`,
                'Enrollment Link Sent': `EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount = 0 AND el.IsActive = 1 AND (el.ExpiresAt IS NULL OR el.ExpiresAt > GETUTCDATE()))
                    AND NOT (${hasCurrentOrFutureEnrollment})`,
                'Enrollment Link Used': `EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount > 0 AND el.IsActive = 1)`,
                'Not Enrolled': `NOT (${hasCurrentOrFutureEnrollment})
                    AND NOT EXISTS (SELECT 1 FROM oe.DeclineAcknowledgements da WHERE da.MemberId = m.MemberId AND da.Status = 'Active')
                    AND NOT EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.IsActive = 1)`
            };
            
            if (countStatusConditions[enrollmentStatusFilter]) {
                countWhereClause += ` AND ${countStatusConditions[enrollmentStatusFilter]}`;
            }
        }
        
        const countResult = await countRequest.query(`
                SELECT COUNT(DISTINCT m.MemberId) as TotalCount
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                WHERE ${countWhereClause}
            `);
        
        const totalCount = countResult.recordset[0].TotalCount;
        
        logger.info(`[GROUP-MEMBERS-ROUTE] Total count: ${totalCount}, fetching page ${pageNum}`);
        console.log(`[GROUP-MEMBERS-ROUTE] Total count: ${totalCount}, fetching page ${pageNum}`);
        
        // Build main query with parameters
        const request = pool.request()
            .input('GroupId', sql.UniqueIdentifier, groupId);
            
        if (locationFilter !== 'all') {
            request.input('LocationId', sql.UniqueIdentifier, locationFilter);
        }
        
        if (search && search.trim()) {
            request.input('Search', sql.NVarChar, `%${search.trim()}%`);
        }
        
        // Get paginated member data
        console.log(`[GROUP-MEMBERS-ROUTE] About to execute main query with whereClause: ${whereClause}, sortField: ${sortField}`);
        const membersResult = await request.query(`
                SELECT 
                    m.MemberId, m.UserId, m.GroupId,
                    m.Status, m.RelationshipType, 
                    FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                    FORMAT(m.HireDate, 'yyyy-MM-dd') as HireDate,
                    m.Address, m.City, m.State, m.Zip, m.Gender,
                    m.WorkLocation, m.JobPosition, m.Tier, m.TobaccoUse,
                    m.HouseholdId, m.MemberSequence, m.CreatedDate,
                    m.LocationId,
                    gl.Name as LocationName,
                    u.Email, u.PhoneNumber,
                    u.FirstName, u.LastName,
                    CASE 
                        WHEN m.RelationshipType = 'P' THEN 'Primary'
                        WHEN m.RelationshipType IS NULL THEN 'Primary'
                        WHEN m.RelationshipType = 'S' THEN 'Spouse'
                        WHEN m.RelationshipType = 'C' THEN 'Child'
                        ELSE 'Other'
                    END AS RelationshipDescription,
                    -- Enhanced enrollment status (include future-effective enrollments as Enrolled)
                    -- Has current or future effective enrollment: currently effective OR (Status Active/Pending and EffectiveDate in future)
                    CASE 
                        WHEN EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending') AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE()))) AND u.PasswordHash IS NULL THEN 'Pending Login'
                        WHEN EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending') AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE()))) THEN 'Enrolled'
                        WHEN EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Pending') THEN 'Pending Approval'
                        WHEN EXISTS (SELECT 1 FROM oe.DeclineAcknowledgements da WHERE da.MemberId = m.MemberId AND da.Status = 'Active') THEN 'Declined Coverage'
                        WHEN m.Status = 'Terminated' THEN 'Terminated'
                        WHEN EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId)
                            AND NOT EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending') AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE())))
                            AND NOT EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Pending') THEN 'Terminated'
                        WHEN EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount = 0 AND el.IsActive = 1 AND (el.ExpiresAt IS NULL OR el.ExpiresAt > GETUTCDATE()))
                            AND NOT EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending') AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE()))) THEN 'Enrollment Link Sent'
                        WHEN EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount > 0 AND el.IsActive = 1) THEN 'Enrollment Link Used'
                        ELSE 'Not Enrolled'
                    END AS EnrollmentStatus,
                    -- Enrollment status priority for sorting (Not Enrolled = 1, Enrolled = 2)
                    CASE 
                        WHEN EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending') AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE()))) AND u.PasswordHash IS NULL THEN 2
                        WHEN EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending') AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE()))) THEN 2
                        WHEN EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Pending') THEN 2
                        WHEN m.Status = 'Terminated' THEN 2
                        WHEN EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId)
                            AND NOT EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending') AND ((e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())) OR (e.EffectiveDate > GETUTCDATE())))
                            AND NOT EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Pending') THEN 2
                        WHEN EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount = 0 AND el.IsActive = 1) THEN 2
                        WHEN EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.MemberId = m.MemberId AND el.UsageCount > 0 AND el.IsActive = 1) THEN 2
                        ELSE 1
                    END AS EnrollmentStatusPriority,
                    ${MEMBER_LIST_ENROLLMENT_LINK_SENT_AT_SQL},
                    -- Calculate household monthly premium using SQL function
                    oe.fn_GetHouseholdMonthlyPremium(m.HouseholdId) AS MonthlyPremium,
                    -- Household employer share: Contribution rows trump Product/fees EmployerContributionAmount when both exist
                    (${householdEmployerContributionCaseSql({ effectiveCmp: '<= GETUTCDATE()', terminationCmp: '> GETUTCDATE()' })}) AS EmployerContribution,
                    -- Total Premium (Product + Fees) minus total employer share (same date window as above)
                    ISNULL((
                        SELECT SUM(e.PremiumAmount)
                        FROM oe.Enrollments e
                        JOIN oe.Members hm ON e.MemberId = hm.MemberId
                        WHERE hm.HouseholdId = m.HouseholdId
                        AND e.EffectiveDate <= GETUTCDATE()
                        AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
                        AND (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product', 'PaymentProcessingFee', 'ProcessingFee', 'SystemFee'))
                    ), 0) - (${householdEmployerContributionCaseSql({ effectiveCmp: '<= GETUTCDATE()', terminationCmp: '> GETUTCDATE()' })}) AS EmployeeContribution,
                    -- Count dependents in household
                    (SELECT COUNT(*) 
                     FROM oe.Members d 
                     WHERE d.HouseholdId = m.HouseholdId 
                     AND d.RelationshipType IN ('S', 'C')
                     AND d.Status != 'Terminated'
                     AND d.GroupId = m.GroupId) AS DependentCount,
                    -- Agent information
                    m.AgentId,
                    ISNULL(ag.FirstName, '') + ' ' + ISNULL(ag.LastName, '') as AgentName,
                    ag.Email as AgentEmail,
                    -- Group agent information
                    g.AgentId as GroupAgentId,
                    ISNULL(gag.FirstName, '') + ' ' + ISNULL(gag.LastName, '') as GroupAgentName,
                    gag.Email as GroupAgentEmail,
                    -- Latest active product enrollment's EffectiveDate (for cohort column + filter)
                    latestEnrollment.EffectiveDate AS EffectiveDate
                FROM oe.Members m
                JOIN oe.Users u ON m.UserId = u.UserId
                LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
                LEFT JOIN oe.GroupLocations gl ON m.LocationId = gl.LocationId
                LEFT JOIN oe.Agents a ON m.AgentId = a.AgentId
                LEFT JOIN oe.Users ag ON a.UserId = ag.UserId
                LEFT JOIN oe.Agents ga ON g.AgentId = ga.AgentId
                LEFT JOIN oe.Users gag ON ga.UserId = gag.UserId
                OUTER APPLY (
                    SELECT TOP 1 e.EffectiveDate
                    FROM oe.Enrollments e
                    WHERE e.MemberId = m.MemberId
                      AND e.EnrollmentType = 'Product'
                      AND e.Status = 'Active'
                    ORDER BY e.EffectiveDate DESC, e.CreatedDate DESC
                ) latestEnrollment
                WHERE ${whereClause}
                ORDER BY ${sortField} ${sortDirection}
                OFFSET ${offset} ROWS
                FETCH NEXT ${pageSizeNum} ROWS ONLY
            `);

        // Get the members with their basic data
        const members = membersResult.recordset;
        
        logger.info(`[GROUP-MEMBERS-ROUTE] Returning ${members.length} members (page ${pageNum} of ${Math.ceil(totalCount / pageSizeNum)})`);

        // Helper function to get enrollment status color
        const getEnrollmentStatusColor = (status) => {
            switch (status) {
                case 'Enrolled':
                    return 'success';
                case 'Pending Login':
                    return 'warning'; // Amber/orange for pending login
                case 'Pending Approval':
                    return 'warning';
                case 'Enrollment Link Sent':
                    return 'info';
                case 'Enrollment Link Used':
                    return 'secondary';
                case 'Declined Coverage':
                    return 'error'; // Bright red for declined
                case 'Pending Migration':
                    return 'secondary';
                case 'Terminated':
                    return 'error';
                case 'Not Enrolled':
                    return 'warning'; // Amber/orange for not enrolled
                default:
                    return 'default';
            }
        };

        // Get total enrollment status counts for the entire group (not just current page)
        let statusCounts = {};
        try {
            const statusCountsResult = await pool.request()
                .input('GroupId', sql.UniqueIdentifier, groupId)
                .query(`
                    SELECT 
                        CASE 
                            WHEN EXISTS (SELECT 1 FROM oe.Enrollments ex WHERE ex.MemberId = m.MemberId AND ex.Status IN ('Active', 'Pending') AND ((ex.EffectiveDate <= GETUTCDATE() AND (ex.TerminationDate IS NULL OR ex.TerminationDate > GETUTCDATE())) OR (ex.EffectiveDate > GETUTCDATE()))) AND u.PasswordHash IS NULL THEN 'Pending Login'
                            WHEN EXISTS (SELECT 1 FROM oe.Enrollments ex WHERE ex.MemberId = m.MemberId AND ex.Status IN ('Active', 'Pending') AND ((ex.EffectiveDate <= GETUTCDATE() AND (ex.TerminationDate IS NULL OR ex.TerminationDate > GETUTCDATE())) OR (ex.EffectiveDate > GETUTCDATE()))) THEN 'Enrolled'
                            WHEN EXISTS (SELECT 1 FROM oe.Enrollments ex WHERE ex.MemberId = m.MemberId AND ex.Status = 'Pending') THEN 'Pending Approval'
                            WHEN da.DeclineAcknowledgementId IS NOT NULL THEN 'Declined Coverage'
                            WHEN m.Status = 'Terminated' THEN 'Terminated'
                            WHEN EXISTS (SELECT 1 FROM oe.Enrollments ex WHERE ex.MemberId = m.MemberId)
                                AND NOT EXISTS (SELECT 1 FROM oe.Enrollments ex WHERE ex.MemberId = m.MemberId AND ex.Status IN ('Active', 'Pending') AND ((ex.EffectiveDate <= GETUTCDATE() AND (ex.TerminationDate IS NULL OR ex.TerminationDate > GETUTCDATE())) OR (ex.EffectiveDate > GETUTCDATE())))
                                AND NOT EXISTS (SELECT 1 FROM oe.Enrollments ex WHERE ex.MemberId = m.MemberId AND ex.Status = 'Pending') THEN 'Terminated'
                            WHEN el.LinkId IS NOT NULL AND el.UsageCount = 0 AND el.IsActive = 1 AND (el.ExpiresAt IS NULL OR el.ExpiresAt > GETUTCDATE())
                                AND NOT EXISTS (SELECT 1 FROM oe.Enrollments ex WHERE ex.MemberId = m.MemberId AND ex.Status IN ('Active', 'Pending') AND ((ex.EffectiveDate <= GETUTCDATE() AND (ex.TerminationDate IS NULL OR ex.TerminationDate > GETUTCDATE())) OR (ex.EffectiveDate > GETUTCDATE()))) THEN 'Enrollment Link Sent'
                            WHEN el.LinkId IS NOT NULL AND el.UsageCount > 0 AND el.IsActive = 1 THEN 'Enrollment Link Used'
                            ELSE 'Not Enrolled'
                        END AS EnrollmentStatus,
                        COUNT(DISTINCT m.MemberId) as Count
                    FROM oe.Members m
                    JOIN oe.Users u ON m.UserId = u.UserId
                    LEFT JOIN oe.DeclineAcknowledgements da ON m.MemberId = da.MemberId AND da.Status = 'Active'
                    LEFT JOIN oe.EnrollmentLinks el ON m.MemberId = el.MemberId
                    WHERE m.GroupId = @GroupId AND (m.RelationshipType = 'P' OR m.RelationshipType IS NULL)${showTerminated !== 'true' ? " AND m.Status != 'Terminated'" : ''}${showInactive !== 'true' ? " AND m.Status != 'Inactive'" : ''}
                    GROUP BY 
                        CASE 
                            WHEN EXISTS (SELECT 1 FROM oe.Enrollments ex WHERE ex.MemberId = m.MemberId AND ex.Status IN ('Active', 'Pending') AND ((ex.EffectiveDate <= GETUTCDATE() AND (ex.TerminationDate IS NULL OR ex.TerminationDate > GETUTCDATE())) OR (ex.EffectiveDate > GETUTCDATE()))) AND u.PasswordHash IS NULL THEN 'Pending Login'
                            WHEN EXISTS (SELECT 1 FROM oe.Enrollments ex WHERE ex.MemberId = m.MemberId AND ex.Status IN ('Active', 'Pending') AND ((ex.EffectiveDate <= GETUTCDATE() AND (ex.TerminationDate IS NULL OR ex.TerminationDate > GETUTCDATE())) OR (ex.EffectiveDate > GETUTCDATE()))) THEN 'Enrolled'
                            WHEN EXISTS (SELECT 1 FROM oe.Enrollments ex WHERE ex.MemberId = m.MemberId AND ex.Status = 'Pending') THEN 'Pending Approval'
                            WHEN da.DeclineAcknowledgementId IS NOT NULL THEN 'Declined Coverage'
                            WHEN m.Status = 'Terminated' THEN 'Terminated'
                            WHEN EXISTS (SELECT 1 FROM oe.Enrollments ex WHERE ex.MemberId = m.MemberId)
                                AND NOT EXISTS (SELECT 1 FROM oe.Enrollments ex WHERE ex.MemberId = m.MemberId AND ex.Status IN ('Active', 'Pending') AND ((ex.EffectiveDate <= GETUTCDATE() AND (ex.TerminationDate IS NULL OR ex.TerminationDate > GETUTCDATE())) OR (ex.EffectiveDate > GETUTCDATE())))
                                AND NOT EXISTS (SELECT 1 FROM oe.Enrollments ex WHERE ex.MemberId = m.MemberId AND ex.Status = 'Pending') THEN 'Terminated'
                            WHEN el.LinkId IS NOT NULL AND el.UsageCount = 0 AND el.IsActive = 1 AND (el.ExpiresAt IS NULL OR el.ExpiresAt > GETUTCDATE())
                                AND NOT EXISTS (SELECT 1 FROM oe.Enrollments ex WHERE ex.MemberId = m.MemberId AND ex.Status IN ('Active', 'Pending') AND ((ex.EffectiveDate <= GETUTCDATE() AND (ex.TerminationDate IS NULL OR ex.TerminationDate > GETUTCDATE())) OR (ex.EffectiveDate > GETUTCDATE()))) THEN 'Enrollment Link Sent'
                            WHEN el.LinkId IS NOT NULL AND el.UsageCount > 0 AND el.IsActive = 1 THEN 'Enrollment Link Used'
                            ELSE 'Not Enrolled'
                        END
                `);
            
            statusCountsResult.recordset.forEach(row => {
                statusCounts[row.EnrollmentStatus] = row.Count;
            });
            
            // Ensure all statuses have a count (even if 0)
            // Note: 'Pending Approval' and 'Enrollment Link Used' are kept in backend logic for edge cases
            // but not displayed in UI since they're not used in practice
            const allStatuses = ['Enrolled', 'Pending Login', 'Declined Coverage', 'Terminated', 'Enrollment Link Sent', 'Not Enrolled'];
            allStatuses.forEach(status => {
                if (!statusCounts[status]) {
                    statusCounts[status] = 0;
                }
            });
            
        } catch (error) {
            logger.error(`[GROUP-MEMBERS-ROUTE] Error fetching status counts: ${error.message}`);
            // Set default counts if query fails
            statusCounts = {
                'Enrolled': 0,
                'Pending Login': 0,
                'Declined Coverage': 0,
                'Terminated': 0,
                'Enrollment Link Sent': 0,
                'Not Enrolled': 0
            };
        }

        // Enrollment summary: total premium, household counts (enrolled effective, future effective, total)
        let enrollmentSummary = { totalPremium: 0, enrolledHouseholdsCount: 0, futureEffectiveHouseholdsCount: 0, totalHouseholdsCount: 0 };
        try {
            const summaryResult = await pool.request()
                .input('GroupId', sql.UniqueIdentifier, groupId)
                .query(`
                    SELECT 
                        ISNULL((SELECT SUM(e.PremiumAmount)
                            FROM oe.Enrollments e
                            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
                            WHERE m.GroupId = @GroupId
                            AND e.EffectiveDate <= GETUTCDATE()
                            AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
                            AND e.Status IN ('Active', 'Pending')
                            AND (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product', 'PaymentProcessingFee', 'SystemFee'))), 0) AS TotalPremium,
                        ISNULL((SELECT COUNT(DISTINCT m.HouseholdId)
                            FROM oe.Members m
                            INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
                            WHERE m.GroupId = @GroupId
                            AND e.EffectiveDate <= GETUTCDATE()
                            AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
                            AND e.Status IN ('Active', 'Pending')), 0) AS EnrolledHouseholdsCount,
                        ISNULL((SELECT COUNT(DISTINCT m.HouseholdId)
                            FROM oe.Members m
                            INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
                            WHERE m.GroupId = @GroupId
                            AND e.EffectiveDate > GETUTCDATE()
                            AND e.Status IN ('Active', 'Pending')), 0) AS FutureEffectiveHouseholdsCount,
                        ISNULL((SELECT COUNT(DISTINCT m.HouseholdId)
                            FROM oe.Members m
                            WHERE m.GroupId = @GroupId AND (m.RelationshipType = 'P' OR m.RelationshipType IS NULL)), 0) AS TotalHouseholdsCount
                `);
            const row = summaryResult.recordset[0];
            if (row) {
                enrollmentSummary = {
                    totalPremium: Number(row.TotalPremium) || 0,
                    enrolledHouseholdsCount: Number(row.EnrolledHouseholdsCount) || 0,
                    futureEffectiveHouseholdsCount: Number(row.FutureEffectiveHouseholdsCount) || 0,
                    totalHouseholdsCount: Number(row.TotalHouseholdsCount) || 0
                };
            }
        } catch (error) {
            logger.error(`[GROUP-MEMBERS-ROUTE] Error fetching enrollment summary: ${error.message}`);
        }

        // If there are members, get their enrollment stats (MonthlyPremium already calculated by SQL function)
        if (members.length > 0) {
            try {
                // Get member IDs as a comma-separated string for the IN clause
                const memberIds = members.map(m => `'${m.MemberId}'`).join(',');
                
                // Get enrollment stats for all members in one query (MonthlyPremium already from SQL function)
                const statsResult = await pool.request()
                    .query(`
                        SELECT 
                            e.MemberId,
                            COUNT(*) AS TotalEnrollments,
                            SUM(CASE WHEN e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()) THEN 1 ELSE 0 END) AS ActiveEnrollments
                        FROM oe.Enrollments e
                        WHERE e.MemberId IN (${memberIds})
                        GROUP BY e.MemberId
                    `);
                
                // Create a lookup map for quick access
                const statsMap = {};
                statsResult.recordset.forEach(stat => {
                    statsMap[stat.MemberId] = {
                        TotalEnrollments: stat.TotalEnrollments,
                        ActiveEnrollments: stat.ActiveEnrollments
                    };
                });
                
                // Add stats to each member (MonthlyPremium already set from SQL function)
                members.forEach(member => {
                    const stats = statsMap[member.MemberId] || { 
                        TotalEnrollments: 0, 
                        ActiveEnrollments: 0
                    };
                    
                    member.TotalEnrollments = stats.TotalEnrollments;
                    member.ActiveEnrollments = stats.ActiveEnrollments;
                    // MonthlyPremium already calculated by oe.fn_GetHouseholdMonthlyPremium()
                    
                    // Add enrollment status color
                    member.EnrollmentStatusColor = getEnrollmentStatusColor(member.EnrollmentStatus);
                });

                // Enrolled plan names for display: bundle name when enrollment is in a bundle, else product name (current + future effective)
                const planNamesResult = await pool.request().query(`
                    SELECT DISTINCT e.MemberId, COALESCE(bundle.Name, p.Name) AS PlanName
                    FROM oe.Enrollments e
                    INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                    LEFT JOIN oe.Products bundle ON e.ProductBundleId = bundle.ProductId
                    WHERE e.MemberId IN (${memberIds})
                      AND e.Status IN ('Active', 'Pending')
                      AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                      AND e.ProductId != '00000000-0000-0000-0000-000000000000'
                      AND (
                        (e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()))
                        OR (e.EffectiveDate > GETUTCDATE())
                      )
                    ORDER BY e.MemberId, PlanName
                `);
                const planNamesMap = {};
                (planNamesResult.recordset || []).forEach((row) => {
                    if (!planNamesMap[row.MemberId]) planNamesMap[row.MemberId] = [];
                    if (!planNamesMap[row.MemberId].includes(row.PlanName)) planNamesMap[row.MemberId].push(row.PlanName);
                });
                members.forEach(m => {
                    m.EnrolledPlanNames = planNamesMap[m.MemberId] || [];
                });
            } catch (error) {
                // If there's an error getting stats, just log it and continue with basic member data
                logger.error(`[GROUP-MEMBERS-ROUTE] Error fetching enrollment stats: ${error.message}`);
                
                // Set default values for all members (including when plan-names query fails)
                members.forEach(member => {
                    member.TotalEnrollments = 0;
                    member.ActiveEnrollments = 0;
                    member.EnrolledPlanNames = member.EnrolledPlanNames || [];
                    // MonthlyPremium already calculated by SQL function
                    member.EnrollmentStatusColor = getEnrollmentStatusColor(member.EnrollmentStatus);
                });
            }
        } else {
            // No members found, just log and return empty array
            logger.info(`[GROUP-MEMBERS-ROUTE] No members found for group ID: ${groupId}`);
        }

        logger.info(
            `[GROUP-MEMBERS-ROUTE] Successfully fetched ${members.length} members for group ID: ${groupId}`
        );
        res.json({
            success: true,
            data: {
                members: members,
                statusCounts: statusCounts,
                enrollmentSummary,
                pagination: {
                    page: pageNum,
                    pageSize: pageSizeNum,
                    totalCount: totalCount,
                    totalPages: Math.ceil(totalCount / pageSizeNum)
                }
            }
        });
    } catch (error) {
        console.error(`[GROUP-MEMBERS-ROUTE] ❌ ERROR:`, error.message);
        console.error(`[GROUP-MEMBERS-ROUTE] ❌ STACK:`, error.stack);
        logger.error(`[GROUP-MEMBERS-ROUTE] Error fetching members for group ${groupId}:`, error);
        logger.error(`[GROUP-MEMBERS-ROUTE] Error stack:`, error.stack);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching group members.',
            error: {
                message: error.message,
                code: error.code
            }
        });
    }
});

/**
 * @route   GET /api/groups/:groupId/members/report
 * @desc    Download a CSV report of group members with optional filters and totals
 * @access  Private (SysAdmin, TenantAdmin, GroupAdmin, Agent)
 * @query   scope=active|all (default: active)
 *          includeDependents=true|false (default: false)
 *          includeDateOfBirth=true|false (default: false)
 *          includeHireDate=true|false (default: false)
 *          includeContributions=true|false — default true when the query param is omitted (pass the string false to omit); SPA typically sends explicitly
 *          includePlanDetails=true|false (default: false) - one row per product for primary only
 *          includeFees=true|false (default: false) - one row "Fees" per primary household (system + processing; 0.00 if none in DB)
 *          includeLocation=true|false (default: false) - include Location column
 *          includeTotalPremium=true|false (default: true) - include TotalPremium column
 *          includeCompanyRole=true|false (default: false) - include Company Role (JobPosition) column
 *          includeTobacco=true|false (default: false) - include Tobacco column (Y/N/N/A)
 *          includeGender=true|false (default: false) - include Gender column
 *          reportYear=YYYY (optional, default: current UTC year) — with reportMonth, sets "as of" end of that month (UTC)
 *          reportMonth=1-12 (optional, default: current UTC month)
 *          Premiums and active scope use enrollments effective on/before month end and not terminated before month end (date-based; includes last-day-of-month terminations).
 */
router.get(
    '/:groupId/members/report-default-period',
    authorize(['SysAdmin', 'TenantAdmin', 'GroupAdmin', 'Agent']),
    async (req, res) => {
        const { groupId } = req.params;

        try {
            const now = new Date();
            const currentYear = now.getUTCFullYear();
            const currentMonth = now.getUTCMonth() + 1;
            const currentAsOf = new Date(Date.UTC(currentYear, currentMonth, 0, 23, 59, 59, 999));

            const pool = await getPool();
            const request = pool.request();
            request.input('GroupId', sql.UniqueIdentifier, groupId);
            request.input('CurrentAsOf', sql.DateTime2, currentAsOf);

            const activeResult = await request.query(`
                SELECT TOP 1 1 AS HasActive
                FROM oe.Enrollments e
                JOIN oe.Members m ON e.MemberId = m.MemberId
                WHERE m.GroupId = @GroupId
                  AND e.EffectiveDate <= @CurrentAsOf
                  AND (e.TerminationDate IS NULL OR e.TerminationDate > @CurrentAsOf)
            `);

            if ((activeResult.recordset || []).length > 0) {
                return res.json({
                    success: true,
                    data: {
                        reportYear: currentYear,
                        reportMonth: currentMonth,
                        source: 'current'
                    }
                });
            }

            const futureResult = await request.query(`
                SELECT MIN(e.EffectiveDate) AS EarliestFutureEffectiveDate
                FROM oe.Enrollments e
                JOIN oe.Members m ON e.MemberId = m.MemberId
                WHERE m.GroupId = @GroupId
                  AND e.EffectiveDate > @CurrentAsOf
                  AND (e.TerminationDate IS NULL OR e.TerminationDate > e.EffectiveDate)
            `);

            const futureDate = futureResult.recordset?.[0]?.EarliestFutureEffectiveDate;
            if (futureDate) {
                const d = new Date(futureDate);
                return res.json({
                    success: true,
                    data: {
                        reportYear: d.getUTCFullYear(),
                        reportMonth: d.getUTCMonth() + 1,
                        source: 'future'
                    }
                });
            }

            return res.json({
                success: true,
                data: {
                    reportYear: currentYear,
                    reportMonth: currentMonth,
                    source: 'current'
                }
            });
        } catch (error) {
            logger.error('[GROUP-MEMBERS-REPORT-DEFAULT] Error getting default report period', { error });
            return res.status(500).json({
                success: false,
                message: 'Server error while getting default report period',
                error: { message: error.message }
            });
        }
    }
);

router.get(
    '/:groupId/members/report',
    authorize(['SysAdmin', 'TenantAdmin', 'GroupAdmin', 'Agent']),
    async (req, res) => {
        const { groupId } = req.params;
        const {
            scope = 'active',
            includeDependents = 'false',
            includeDateOfBirth = 'false',
            includeHireDate = 'false',
            includeContributions = 'false',
            includePlanDetails = 'false',
            includeFees = 'false',
            includeLocation = 'false',
            includeTotalPremium = 'true',
            includeCompanyRole = 'false',
            includeTobacco = 'false',
            includeGender = 'false',
            reportYear: reportYearQ,
            reportMonth: reportMonthQ
        } = req.query;

        const now = new Date();
        const qy = parseInt(String(reportYearQ ?? ''), 10);
        const qm = parseInt(String(reportMonthQ ?? ''), 10);
        const reportYear = Number.isFinite(qy) && qy >= 2000 && qy <= 2100 ? qy : now.getUTCFullYear();
        const reportMonth = Number.isFinite(qm) && qm >= 1 && qm <= 12 ? qm : now.getUTCMonth() + 1;
        /** Last instant of selected month (UTC); effective-date cutoff for report */
        const reportAsOf = new Date(Date.UTC(reportYear, reportMonth, 0, 23, 59, 59, 999));
        /** Last calendar day of selected month (UTC date); termination on this day still counts as covered */
        const reportMonthEndDate = new Date(Date.UTC(reportYear, reportMonth, 0));

        logger.info(
            `[GROUP-MEMBERS-REPORT] Request to generate members report for group ID: ${groupId}`,
            {
                scope,
                includeDependents,
                includeDateOfBirth,
                includeHireDate,
                includeContributions,
                includePlanDetails,
                includeFees,
                includeLocation,
                includeTotalPremium,
                includeCompanyRole,
                includeTobacco,
                includeGender,
                reportYear,
                reportMonth,
                reportAsOf: reportAsOf.toISOString()
            }
        );

        try {
            const pool = await getPool();
            const request = pool.request();
            request.input('GroupId', sql.UniqueIdentifier, groupId);
            request.input('ReportAsOf', sql.DateTime2, reportAsOf);
            request.input('ReportMonthEndDate', sql.Date, reportMonthEndDate);

            const includeDependentsBool = includeDependents === 'true';
            const includeDateOfBirthBool = includeDateOfBirth === 'true';
            const includeHireDateBool = includeHireDate === 'true';
            const includeContributionsBool = includeContributions !== 'false';
            const includePlanDetailsBool = includePlanDetails === 'true';
            const includeFeesBool = includeFees === 'true';
            const includeLocationBool = includeLocation === 'true';
            const includeTotalPremiumBool = includeTotalPremium !== 'false';
            const includeCompanyRoleBool = includeCompanyRole === 'true';
            const includeTobaccoBool = includeTobacco === 'true';
            const includeGenderBool = includeGender === 'true';
            const scopeActiveOnly = scope !== 'all';

            // Base WHERE for group
            let whereClause = 'm.GroupId = @GroupId';

            // Relationship filter: only include dependents when their primary has an active enrollment (do not include children/spouses without active primary)
            if (!includeDependentsBool) {
                whereClause += ' AND (m.RelationshipType = \'P\' OR m.RelationshipType IS NULL)';
            } else {
                whereClause += ` AND (m.RelationshipType = 'P' OR m.RelationshipType IS NULL OR EXISTS (
                        SELECT 1 FROM oe.Members mp
                        INNER JOIN oe.Enrollments ePrim ON ePrim.MemberId = mp.MemberId
                        WHERE mp.HouseholdId = m.HouseholdId AND (mp.RelationshipType = 'P' OR mp.RelationshipType IS NULL)
                          AND ePrim.EffectiveDate <= @ReportAsOf
                          AND ${reportMonthTerminationActiveSql('ePrim')}
                ))`;
            }

            // Scope filter: at least one enrollment active as of end of selected month only (no future-only rows)
            if (scopeActiveOnly) {
                whereClause += `
                AND EXISTS (
                    SELECT 1
                    FROM oe.Enrollments eScope
                    WHERE eScope.MemberId = m.MemberId
                      AND eScope.EffectiveDate <= @ReportAsOf
                      AND ${reportMonthTerminationActiveSql('eScope')}
                )`;
            }

            // Build SELECT with optional fields and contributions
            // Note: MemberId and HouseholdId are used internally for plan details/fees; not written to CSV
            // HouseholdMemberID is always included
            const selectFields = [
                'm.MemberId',
                'm.HouseholdId',
                'm.HouseholdMemberID',
                'm.UserId',
                'm.GroupId',
                'm.Status',
                'm.RelationshipType',
                'u.FirstName',
                'u.LastName',
                'u.Email',
                'u.PhoneNumber'
            ];
            if (includeLocationBool) {
                selectFields.push('gl.Name as LocationName');
            }

            if (includeDateOfBirthBool) {
                selectFields.push("FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth");
            }

            if (includeHireDateBool) {
                selectFields.push("FORMAT(m.HireDate, 'yyyy-MM-dd') as HireDate");
            }

            if (includeCompanyRoleBool) {
                selectFields.push('m.JobPosition as CompanyRole');
            }

            if (includeTobaccoBool) {
                selectFields.push('m.TobaccoUse');
            }

            if (includeGenderBool) {
                selectFields.push('m.Gender');
            }

            // Premiums/contributions: household totals for enrollments active as of end of selected month only (no future-only)
            // Product enrollments are Product/NULL; fees are SystemFee/PaymentProcessingFee/ProcessingFee.
            selectFields.push(
                `ISNULL((
                    SELECT SUM(e2.PremiumAmount)
                    FROM oe.Enrollments e2
                    JOIN oe.Members hm2 ON e2.MemberId = hm2.MemberId
                    WHERE hm2.HouseholdId = m.HouseholdId
                      AND e2.EffectiveDate <= @ReportAsOf
                      AND ${reportMonthTerminationActiveSql('e2')}
                      AND (e2.EnrollmentType IS NULL OR e2.EnrollmentType IN ('Product', 'PaymentProcessingFee', 'ProcessingFee', 'SystemFee'))
                ), 0) AS TotalPremium`
            );
            if (includeContributionsBool) {
                const reportEmployerCase = householdEmployerContributionCaseSql({
                    effectiveCmp: '<= @ReportAsOf',
                    reportMonthEnd: true,
                });
                selectFields.push(`(${reportEmployerCase}) AS EmployerContribution`);
                // Match roster (/members list): Employee = sum(Product|fee premiums) − household employer CASE — do not derive only in CSV (parity + driver aliases).
                selectFields.push(
                    `(ISNULL((
                    SELECT SUM(e2.PremiumAmount)
                    FROM oe.Enrollments e2
                    JOIN oe.Members hm2 ON e2.MemberId = hm2.MemberId
                    WHERE hm2.HouseholdId = m.HouseholdId
                      AND e2.EffectiveDate <= @ReportAsOf
                      AND ${reportMonthTerminationActiveSql('e2')}
                      AND (e2.EnrollmentType IS NULL OR e2.EnrollmentType IN ('Product', 'PaymentProcessingFee', 'ProcessingFee', 'SystemFee'))
                ), 0) - (${reportEmployerCase})) AS EmployeeContribution`
                );
            }

            // Build GROUP BY clause
            const groupByFields = [
                'm.MemberId',
                'm.HouseholdId',
                'm.HouseholdMemberID',
                'm.UserId',
                'm.GroupId',
                'm.Status',
                'm.RelationshipType',
                'u.FirstName',
                'u.LastName',
                'u.Email',
                'u.PhoneNumber'
            ];
            if (includeLocationBool) {
                groupByFields.push('gl.Name');
            }

            // Add HouseholdId to GROUP BY if we're using it in the function call
            if (!includeContributionsBool) {
                groupByFields.push('m.HouseholdId');
            }

            if (includeDateOfBirthBool) {
                groupByFields.push('m.DateOfBirth');
            }

            if (includeHireDateBool) {
                groupByFields.push('m.HireDate');
            }

            if (includeCompanyRoleBool) {
                groupByFields.push('m.JobPosition');
            }

            if (includeTobaccoBool) {
                groupByFields.push('m.TobaccoUse');
            }

            if (includeGenderBool) {
                groupByFields.push('m.Gender');
            }

            const query = `
            SELECT
                ${selectFields.join(',\n                ')}
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.GroupLocations gl ON m.LocationId = gl.LocationId
            LEFT JOIN oe.Enrollments e ON e.MemberId = m.MemberId
            WHERE ${whereClause}
            GROUP BY
                ${groupByFields.join(',\n                ')}
            ORDER BY
                u.LastName,
                u.FirstName
        `;

            logger.debug('[GROUP-MEMBERS-REPORT] Executing report query', { query });

            const result = await request.query(query);
            const members = result.recordset || [];

            if (members.length === 0) {
                // Return empty CSV instead of 404 - empty report is valid
                const headers = ['HouseholdMemberID', 'FirstName', 'LastName', 'Email', 'PhoneNumber', 'Status', 'RelationshipType'];
                const csvContent = headers.join(',') + '\n';
                res.setHeader('Content-Type', 'text/csv');
                res.setHeader('Content-Disposition', `attachment; filename="group-members-report-${new Date().toISOString().split('T')[0]}.csv"`);
                return res.send(csvContent);
            }

            // Optional: product breakdown per primary member (for includePlanDetails)
            const productsByMemberId = new Map();
            if (includePlanDetailsBool) {
                const primaryMemberIds = members
                    .filter((m) => m.RelationshipType === 'P' || m.RelationshipType == null)
                    .map((m) => m.MemberId)
                    .filter(Boolean);
                if (primaryMemberIds.length > 0) {
                    const placeholders = primaryMemberIds.map((_, i) => `@MemberId${i}`).join(',');
                    const productRequest = pool.request();
                    productRequest.input('ReportAsOf', sql.DateTime2, reportAsOf);
                    productRequest.input('ReportMonthEndDate', sql.Date, reportMonthEndDate);
                    primaryMemberIds.forEach((id, i) => {
                        productRequest.input(`MemberId${i}`, sql.UniqueIdentifier, id);
                    });
                    const productQuery = `
                        SELECT e.MemberId, p.Name AS ProductName, e.PremiumAmount,
                          COALESCE(pp.Label, m.Tier) AS PriceTier
                        FROM oe.Enrollments e
                        JOIN oe.Members m ON e.MemberId = m.MemberId
                        JOIN oe.Products p ON e.ProductId = p.ProductId
                        LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
                        WHERE m.MemberId IN (${placeholders})
                          AND (
                            (
                              EXISTS (
                                SELECT 1
                                FROM oe.Enrollments ea
                                JOIN oe.Members hma ON ea.MemberId = hma.MemberId
                                WHERE hma.HouseholdId = m.HouseholdId
                                  AND ea.EffectiveDate <= @ReportAsOf
                                  AND ${reportMonthTerminationActiveSql('ea')}
                              )
                              AND e.EffectiveDate <= @ReportAsOf
                              AND ${reportMonthTerminationActiveSql('e')}
                            )
                            OR
                            (
                              NOT EXISTS (
                                SELECT 1
                                FROM oe.Enrollments ea
                                JOIN oe.Members hma ON ea.MemberId = hma.MemberId
                                WHERE hma.HouseholdId = m.HouseholdId
                                  AND ea.EffectiveDate <= @ReportAsOf
                                  AND ${reportMonthTerminationActiveSql('ea')}
                              )
                              AND e.EffectiveDate > @ReportAsOf
                              AND ${reportMonthTerminationActiveSql('e')}
                            )
                          )
                          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                          AND e.ProductId != '00000000-0000-0000-0000-000000000000'
                        ORDER BY e.MemberId, p.Name
                    `;
                    const productResult = await productRequest.query(productQuery);
                    const productRows = productResult.recordset || [];
                    productRows.forEach((row) => {
                        const memberIdKey = row.MemberId;
                        if (!productsByMemberId.has(memberIdKey)) {
                            productsByMemberId.set(memberIdKey, []);
                        }
                        productsByMemberId.get(memberIdKey).push({
                            ProductName: row.ProductName,
                            PremiumAmount: Number(row.PremiumAmount || 0),
                            PriceTier: row.PriceTier || ''
                        });
                    });
                }
            }

            // Optional: household fees (system + payment processing) per household
            const feesByHouseholdId = new Map();
            if (includeFeesBool) {
                const primaryHouseholdIds = members
                    .filter((m) => (m.RelationshipType === 'P' || m.RelationshipType == null) && m.HouseholdId)
                    .map((m) => m.HouseholdId);
                const uniqueHouseholdIds = [...new Set(primaryHouseholdIds)];
                if (uniqueHouseholdIds.length > 0) {
                    const placeholders = uniqueHouseholdIds.map((_, i) => `@HouseholdId${i}`).join(',');
                    const feeRequest = pool.request();
                    feeRequest.input('ReportAsOf', sql.DateTime2, reportAsOf);
                    feeRequest.input('ReportMonthEndDate', sql.Date, reportMonthEndDate);
                    uniqueHouseholdIds.forEach((id, i) => {
                        feeRequest.input(`HouseholdId${i}`, sql.UniqueIdentifier, id);
                    });
                    const feeQuery = `
                        SELECT m.HouseholdId,
                          SUM(CASE WHEN e.EnrollmentType = 'SystemFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) AS SystemFees,
                          SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) AS ProcessingFees
                        FROM oe.Enrollments e
                        JOIN oe.Members m ON e.MemberId = m.MemberId
                        WHERE m.HouseholdId IN (${placeholders})
                          AND e.EffectiveDate <= @ReportAsOf
                          AND ${reportMonthTerminationActiveSql('e')}
                          AND e.EnrollmentType IN ('SystemFee', 'PaymentProcessingFee')
                        GROUP BY m.HouseholdId
                    `;
                    const feeResult = await feeRequest.query(feeQuery);
                    (feeResult.recordset || []).forEach((row) => {
                        const system = Number(row.SystemFees || 0);
                        const processing = Number(row.ProcessingFees || 0);
                        feesByHouseholdId.set(row.HouseholdId, system + processing);
                    });
                }
            }

            // Build CSV header: identity cols, [Location], [DOB], [HireDate], [LineItem/LineAmount], [contributions], TotalPremium last
            const headers = [
                'HouseholdMemberID',
                'FirstName',
                'LastName',
                'Email',
                'PhoneNumber',
                'Status',
                'Relationship'
            ];

            if (includeLocationBool) {
                headers.push('Location');
            }

            if (includeDateOfBirthBool) {
                headers.push('DateOfBirth');
            }

            if (includeHireDateBool) {
                headers.push('HireDate');
            }

            if (includeCompanyRoleBool) {
                headers.push('Company Role');
            }

            if (includeTobaccoBool) {
                headers.push('Tobacco');
            }

            if (includeGenderBool) {
                headers.push('Gender');
            }

            if (includePlanDetailsBool || includeFeesBool) {
                headers.push('Product');
                if (includePlanDetailsBool) {
                    headers.push('Price Tier');
                }
                headers.push('Amount');
            }

            if (includeContributionsBool) {
                headers.push('EmployerContribution', 'EmployeeContribution');
            }

            if (includeTotalPremiumBool) {
                headers.push('TotalPremium');
            }

            const csvRows = [];
            csvRows.push(headers.join(','));

            // Totals for numeric columns
            let totalPremiumSum = 0;
            let employerContributionSum = 0;
            let employeeContributionSum = 0;

            const escapeCsv = (value) => {
                if (value === null || value === undefined) return '';
                const str = String(value);
                if (str.includes('"') || str.includes(',') || str.includes('\n')) {
                    return `"${str.replace(/"/g, '""')}"`;
                }
                return str;
            };

            const pushRow = (member, lineItem, priceTier, lineAmount, countInTotals) => {
                const row = [];
                row.push(escapeCsv(member.HouseholdMemberID || ''));
                row.push(escapeCsv(member.FirstName));
                row.push(escapeCsv(member.LastName));
                row.push(escapeCsv(member.Email));
                row.push(escapeCsv(member.PhoneNumber));
                row.push(escapeCsv(member.Status));
                const relationshipLabel = { P: 'Primary', C: 'Child', S: 'Spouse' }[member.RelationshipType]
                    || (member.RelationshipType == null ? 'Primary' : member.RelationshipType);
                row.push(escapeCsv(relationshipLabel));

                if (includeLocationBool) {
                    row.push(escapeCsv(member.LocationName || ''));
                }

                if (includeDateOfBirthBool) {
                    row.push(escapeCsv(member.DateOfBirth || ''));
                }

                if (includeHireDateBool) {
                    row.push(escapeCsv(member.HireDate || ''));
                }

                if (includeCompanyRoleBool) {
                    row.push(escapeCsv(member.CompanyRole || ''));
                }

                if (includeTobaccoBool) {
                    const tu = member.TobaccoUse;
                    const tobaccoDisplay = (tu === true || tu === 1 || tu === 'Y' || tu === 'Yes') ? 'Y' : (tu === false || tu === 0 || tu === 'N' || tu === 'No') ? 'N' : 'N/A';
                    row.push(escapeCsv(tobaccoDisplay));
                }

                if (includeGenderBool) {
                    row.push(escapeCsv(member.Gender || ''));
                }

                if (includePlanDetailsBool || includeFeesBool) {
                    row.push(escapeCsv(lineItem !== undefined ? lineItem : ''));
                    if (includePlanDetailsBool) {
                        row.push(escapeCsv(priceTier !== undefined ? priceTier : ''));
                    }
                    row.push(lineAmount !== undefined && lineAmount !== '' ? Number(lineAmount).toFixed(2) : '');
                }

                if (includeContributionsBool) {
                    const employer = Number(member.EmployerContribution ?? member.employerContribution ?? 0);
                    const totalPremium = Number(member.TotalPremium ?? member.totalPremium ?? 0);
                    const fromSql = member.EmployeeContribution ?? member.employeeContribution;
                    const employee =
                        fromSql != null && fromSql !== ''
                            ? Number(fromSql)
                            : Math.max(totalPremium - employer, 0);
                    const employeeClamped = Number.isFinite(employee) ? Math.max(employee, 0) : 0;
                    if (countInTotals) {
                        employerContributionSum += employer;
                        employeeContributionSum += employeeClamped;
                    }
                    row.push(employer.toFixed(2));
                    row.push(employeeClamped.toFixed(2));
                }

                const totalPremium = Number(member.TotalPremium ?? member.totalPremium ?? 0);
                if (countInTotals) {
                    totalPremiumSum += totalPremium;
                }
                if (includeTotalPremiumBool) {
                    row.push(totalPremium.toFixed(2));
                }

                csvRows.push(row.join(','));
            };

            members.forEach((member) => {
                const isPrimary = member.RelationshipType === 'P' || member.RelationshipType == null;
                const products = includePlanDetailsBool && isPrimary
                    ? (productsByMemberId.get(member.MemberId) || [])
                    : null;

                if (products && products.length > 0) {
                    products.forEach((p, idx) => {
                        pushRow(member, p.ProductName, p.PriceTier, p.PremiumAmount, idx === 0);
                    });
                } else {
                    pushRow(member, undefined, undefined, undefined, true);
                }

                // Always one Fees row per primary household when requested, so the CSV matches
                // (households with no SystemFee/PaymentProcessingFee enrollments still show 0.00).
                if (includeFeesBool && isPrimary && member.HouseholdId) {
                    const raw = feesByHouseholdId.get(member.HouseholdId);
                    const feeTotal = raw != null && !Number.isNaN(Number(raw)) ? Number(raw) : 0;
                    pushRow(member, 'Fees', undefined, feeTotal, false);
                }
            });

            // Totals row: same column order as headers; TotalPremium last
            const totalsRow = [];
            totalsRow.push('TOTALS');

            const numericColsAtEnd = (includeContributionsBool ? 2 : 0) + (includeTotalPremiumBool ? 1 : 0);
            const nonNumericCount = headers.length - numericColsAtEnd;
            for (let i = 1; i < nonNumericCount; i += 1) {
                totalsRow.push('');
            }

            if (includeContributionsBool) {
                totalsRow.push(employerContributionSum.toFixed(2));
                totalsRow.push(employeeContributionSum.toFixed(2));
            }
            if (includeTotalPremiumBool) {
                totalsRow.push(totalPremiumSum.toFixed(2));
            }

            csvRows.push(totalsRow.join(','));

            const csvContent = csvRows.join('\n');
            const today = new Date().toISOString().split('T')[0];

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="group-members-report-${today}.csv"`
            );
            res.send(csvContent);
        } catch (error) {
            console.error('[GROUP-MEMBERS-REPORT] ❌ Error generating report:', error);
            logger.error('[GROUP-MEMBERS-REPORT] Error generating report', { error });
            res.status(500).json({
                success: false,
                message: 'Server error while generating members report',
                error: {
                    message: error.message
                }
            });
        }
    }
);

/**
 * @route   POST /api/groups/:groupId/members/:memberId/send-password-email
 * @desc    Send password reset or setup email to an enrolled member
 * @access  Private (SysAdmin, TenantAdmin, GroupAdmin, Agent)
 */
router.post('/:groupId/members/:memberId/send-password-email', authorize(['SysAdmin', 'TenantAdmin', 'GroupAdmin', 'Agent']), async (req, res) => {
    const { groupId, memberId } = req.params;
    const crypto = require('crypto');
    const MessageQueueService = require('../services/messageQueue.service');

    try {
        const pool = await getPool();

        // Verify member exists, belongs to group, and has active enrollment
        const memberQuery = `
            SELECT 
                m.MemberId,
                m.UserId,
                u.Email,
                u.FirstName,
                u.LastName,
                u.PasswordHash,
                u.TenantId,
                t.Name as TenantName,
                t.CustomDomain,
                t.AdvancedSettings,
                CASE WHEN EXISTS (
                    SELECT 1 FROM oe.Enrollments e 
                    WHERE e.MemberId = m.MemberId AND e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
                ) THEN 1 ELSE 0 END as HasActiveEnrollment
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            INNER JOIN oe.Tenants t ON u.TenantId = t.TenantId
            WHERE m.MemberId = @MemberId 
                AND m.GroupId = @GroupId
        `;

        const memberRequest = pool.request();
        memberRequest.input('MemberId', sql.UniqueIdentifier, memberId);
        memberRequest.input('GroupId', sql.UniqueIdentifier, groupId);

        const memberResult = await memberRequest.query(memberQuery);

        if (memberResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found or does not belong to this group'
            });
        }

        const member = memberResult.recordset[0];

        // Check if member has active enrollment
        if (!member.HasActiveEnrollment) {
            return res.status(400).json({
                success: false,
                message: 'Member must have an active enrollment to receive password email'
            });
        }

        // Determine if password exists
        const hasPassword = member.PasswordHash !== null && member.PasswordHash.trim() !== '';
        const isPasswordSetup = !hasPassword;

        // Generate token
        const token = crypto.randomBytes(32).toString('hex');
        const expiryHours = isPasswordSetup ? 72 : 0.25; // 72 hours for setup, 15 minutes for reset
        const expiryDate = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

        // Update user with token
        const updateRequest = pool.request();
        updateRequest.input('UserId', sql.UniqueIdentifier, member.UserId);
        updateRequest.input('ResetPasswordToken', sql.NVarChar, token);
        updateRequest.input('ResetPasswordExpiry', sql.DateTime2, expiryDate);

        await updateRequest.query(`
            UPDATE oe.Users 
            SET ResetPasswordToken = @ResetPasswordToken,
                ResetPasswordExpiry = @ResetPasswordExpiry,
                ModifiedDate = GETDATE()
            WHERE UserId = @UserId
        `);

        // Get tenant branding info
        let tenantName = member.TenantName || 'AllAboard365';
        let primaryColor = '#1f6db0';
        let logoUrl = '/images/branding/allaboard365/allaboard365-logo-transparent.png';

        if (member.AdvancedSettings) {
            try {
                const advancedSettings = JSON.parse(member.AdvancedSettings);
                if (advancedSettings.branding) {
                    primaryColor = advancedSettings.branding.primaryColorHex || primaryColor;
                    logoUrl = advancedSettings.branding.logoUrl || logoUrl;
                }
            } catch (parseError) {
                console.warn('⚠️ Could not parse tenant advanced settings:', parseError.message);
            }
        }

        // Construct URL - use custom domain if available, otherwise use request origin
        let baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
        let emailUrl;
        
        if (member.CustomDomain && member.CustomDomain.trim() !== '') {
            emailUrl = `https://${member.CustomDomain}/${isPasswordSetup ? 'setup-password' : 'reset-password'}/${token}`;
        } else {
            emailUrl = `${baseUrl}/${isPasswordSetup ? 'setup-password' : 'reset-password'}/${token}`;
        }

        // Create email content
        const emailSubject = isPasswordSetup 
            ? 'Complete Your Account Setup - Set Your Password'
            : 'Reset Your Password';

        const emailTitle = isPasswordSetup
            ? 'Welcome to Your Health Benefits Portal!'
            : 'Password Reset Request';

        const emailBody = isPasswordSetup
            ? `<p>Dear ${member.FirstName || 'Member'},</p><p>Thank you for completing your enrollment! To access your member portal and view your benefits, please set up your password.</p><p style="margin: 30px 0;"><a href="${emailUrl}" style="background-color: ${primaryColor}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Set Up Your Password</a></p><p><strong>If you have already set up your password, you can sign in to your portal at any time.</strong></p><p>This link will expire in 72 hours for security purposes.</p>`
            : `<p>Hello ${member.FirstName || 'User'},</p><p>We received a request to reset your password for your ${tenantName} account.</p><p style="margin: 30px 0;"><a href="${emailUrl}" style="background-color: ${primaryColor}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Reset Password</a></p><p><strong>Important:</strong> This link will expire in 15 minutes for security reasons. If you didn't request this password reset, please ignore this email.</p>`;

        const htmlContent = `
            <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
            <html xmlns="http://www.w3.org/1999/xhtml">
            <head>
                <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <title>${emailSubject}</title>
            </head>
            <body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: Arial, sans-serif;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f4f4;">
                    <tr>
                        <td align="center" style="padding: 20px 0;">
                            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                                <tr>
                                    <td align="center" style="padding: 30px 20px 20px 20px;">
                                        <img src="${logoUrl}" alt="${tenantName}" style="max-height: 50px; max-width: 200px; display: block;" />
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding: 0 30px 20px 30px;">
                                        <h1 style="margin: 0 0 20px 0; font-size: 24px; font-weight: bold; color: ${primaryColor}; text-align: center; font-family: Arial, sans-serif;">
                                            ${emailTitle}
                                        </h1>
                                        <div style="font-size: 16px; line-height: 1.5; color: #333333; font-family: Arial, sans-serif;">
                                            ${emailBody}
                                            <p style="margin: 20px 0 10px 0; font-size: 14px; color: #666666;">If the button above doesn't work, copy and paste this link into your browser:</p>
                                            <p style="word-break: break-all; color: #666; background-color: #f9fafb; padding: 10px; border-radius: 4px; font-size: 14px;">${emailUrl}</p>
                                        </div>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding: 20px 30px 30px 30px; border-top: 1px solid #eeeeee;">
                                        <p style="margin: 0; font-size: 14px; color: #666666; font-family: Arial, sans-serif;">
                                            Best regards,<br />
                                            The ${tenantName} Team
                                        </p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </body>
            </html>
        `;

        const textContent = isPasswordSetup
            ? `Welcome to Your Health Benefits Portal!

Dear ${member.FirstName || 'Member'},

Thank you for completing your enrollment! To access your member portal and view your benefits, please set up your password.

Set up your password: ${emailUrl}

This link will expire in 72 hours for security purposes.

If you have already set up your password, you can sign in to your portal at any time.

Best regards,
The ${tenantName} Team`.trim()
            : `Password Reset Request

Hello ${member.FirstName || 'User'},

We received a request to reset your password for your ${tenantName} account.

To reset your password, please click the link below or copy and paste it into your browser:

${emailUrl}

IMPORTANT: This link will expire in 15 minutes for security reasons.
If you didn't request this password reset, please ignore this email.

Best regards,
The ${tenantName} Team`.trim();

        // Queue the email
        const messageId = await MessageQueueService.queueEmail({
            tenantId: member.TenantId,
            toEmail: member.Email,
            toName: member.FirstName || 'Member',
            subject: emailSubject,
            htmlContent: htmlContent,
            textContent: textContent,
            messageType: 'Email',
            createdBy: req.user.UserId,
            recipientId: member.UserId
        });

        console.log(`✅ Password ${isPasswordSetup ? 'setup' : 'reset'} email queued successfully: ${messageId} for member ${memberId}`);

        res.json({
            success: true,
            message: `Password ${isPasswordSetup ? 'setup' : 'reset'} email sent successfully`,
            data: {
                emailType: isPasswordSetup ? 'setup' : 'reset',
                messageId: messageId
            }
        });

    } catch (error) {
        console.error('❌ Error sending password email:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send password email',
            error: error.message
        });
    }
});

module.exports = router;
