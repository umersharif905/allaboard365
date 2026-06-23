// backend/routes/agents.js
// This file contains the API endpoints for the Agent Portal.
// It follows the structure of tenantAdmin.js for consistency and robustness.
// All routes are protected and scoped to the authenticated agent.

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize, getUserRoles } = require('../middleware/auth');
const requireTenantAccess = require('../middleware/requireTenantAccess');
const { getSelfAndDownlineAgentIds, getAgentIdsForAgency } = require('../utils/agentHierarchy');
const agencyAdmins = require('../utils/agencyAdmins');
const {
    buildSellingAgentPaymentFilter,
    SCOPE_AGENCY,
    SCOPE_SHOW_ALL
} = require('../utils/sellingAgentPaymentFilter');
const {
    UNRESOLVED_FAILED_PAYMENTS_FROM_P,
    UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE
} = require('../services/billingAuditUnresolvedFailedPayments');

/** Same member/group visibility as GET /api/me/agent/billing/payments */
const AGENT_BILLING_SCOPE_WHERE = `
  AND (
    (m.MemberId IS NOT NULL AND m.AgentId = @viewerAgentId)
    OR EXISTS (
      SELECT 1 FROM oe.Groups gx
      WHERE gx.GroupId = COALESCE(p.GroupId, m.GroupId) AND gx.GroupId IS NOT NULL AND gx.AgentId = @viewerAgentId
    )
  )
`;

function bindAgentIdInClause(request, agentIds, prefix) {
    const uniq = [...new Set((agentIds || []).filter(Boolean))];
    uniq.forEach((id, i) => {
        request.input(`${prefix}${i}`, sql.UniqueIdentifier, id);
    });
    return uniq.length ? uniq.map((_, i) => `@${prefix}${i}`).join(', ') : null;
}

/**
 * @route   GET /api/agents/dashboard
 * @desc    Metrics scoped to agency (AgencyOwner) or self + full downline (Agent). Recent rows use same selling filter as Commissions/Billing.
 * @access  Private (Agent, AgencyOwner, Admin, SysAdmin)
 */
router.get('/dashboard', authorize(['Agent', 'AgencyOwner', 'Admin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const userId = req.user?.UserId || req.user?.userId;
        if (!userId) {
            return res.status(400).json({ success: false, message: 'User ID not found in token' });
        }

        const pool = await getPool();
        const userRoles = getUserRoles(req.user) || [];
        const tenantId = req.user.TenantId;

        const agentRow = await pool
            .request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(
                `SELECT AgentId, AgencyId, AgentCode FROM oe.Agents WHERE UserId = @userId AND Status = N'Active'`
            );

        const viewerAgentId = agentRow.recordset[0]?.AgentId;
        const agencyId = agentRow.recordset[0]?.AgencyId || null;
        const agentCode = agentRow.recordset[0]?.AgentCode || null;
        const isAgencyAdmin =
            viewerAgentId && agencyId ? await agencyAdmins.isAgencyAdmin(pool, agencyId, viewerAgentId) : false;

        if (!viewerAgentId) {
            return res.json({
                success: true,
                data: {
                    totalActiveHouseholds: 0,
                    monthlyPremiumAmount: 0,
                    estimatedMonthlyCommission: 0,
                    failedPayments: 0,
                    recentCommissionPayments: [],
                    recentBillingPayments: [],
                    unresolvedFailedPaymentCount: 0,
                    metricsScope: 'none',
                    metricsScopeIncludesOtherAgents: false,
                    commissionPayoutAverageWindowMonths: 12
                }
            });
        }

        let scopedAgentIds;
        let metricsScope;
        if (isAgencyAdmin && agencyId) {
            scopedAgentIds = await getAgentIdsForAgency(pool, agencyId);
            metricsScope = 'agency';
        } else {
            scopedAgentIds = await getSelfAndDownlineAgentIds(pool, userId);
            metricsScope = 'downline';
        }
        if (!scopedAgentIds.length) {
            scopedAgentIds = [viewerAgentId];
        }

        const salesFilterRaw = isAgencyAdmin && agencyId ? SCOPE_AGENCY : SCOPE_SHOW_ALL;
        const sellingFilter = await buildSellingAgentPaymentFilter(
            req,
            pool,
            viewerAgentId,
            userId,
            agencyId,
            salesFilterRaw
        );
        if (sellingFilter.error) {
            return res.status(sellingFilter.error).json({ success: false, message: sellingFilter.message });
        }

        if (!tenantId) {
            return res.status(400).json({ success: false, message: 'Tenant context required' });
        }

        const productFilter = `e.ProductId <> '00000000-0000-0000-0000-000000000000'`;
        const enrollmentActiveFilter = `(e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())`;

        const householdsReq = pool.request();
        const inH = bindAgentIdInClause(householdsReq, scopedAgentIds, 'sc');
        const householdsResult = await householdsReq.query(`
            SELECT COUNT(DISTINCT m.HouseholdId) AS totalActiveHouseholds
            FROM oe.Members m
            INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
            WHERE m.AgentId IN (${inH})
              AND m.RelationshipType = 'P'
              AND m.Status = 'Active'
              AND ${enrollmentActiveFilter}
              AND ${productFilter}
        `);

        const premiumReq = pool.request();
        const inP = bindAgentIdInClause(premiumReq, scopedAgentIds, 'sc');
        const monthlyPremiumResult = await premiumReq.query(`
            SELECT ISNULL(SUM(e.PremiumAmount), 0) AS monthlyPremiumAmount
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE m.AgentId IN (${inP})
              AND ${enrollmentActiveFilter}
              AND ${productFilter}
        `);

        /** Trailing window for monthly commission average (calendar months with at least one payout). */
        const COMMISSION_PAYOUT_AVG_MONTHS = 12;

        // Viewer-only: NACHA paid to this agent. Average = mean of each calendar month's total (not total÷12, which drags down with quiet months).
        const payoutReq = pool.request();
        payoutReq.input('tenantId', sql.UniqueIdentifier, tenantId);
        payoutReq.input('viewerAgentId', sql.UniqueIdentifier, viewerAgentId);
        const payoutSumResult = await payoutReq.query(`
            WITH MonthlyTotals AS (
              SELECT
                SUM(COALESCE(npd.Amount, 0)) AS MonthTotal
              FROM oe.NACHAPaymentDetails npd
              INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
              WHERE npd.RecipientEntityType = N'Agent'
                AND npd.RecipientEntityId = @viewerAgentId
                AND ng.Status = N'Sent'
                AND ng.TenantId = @tenantId
                AND ng.PayoutType = N'Agent Commission Payouts'
                AND ng.GeneratedDate >= DATEADD(month, -${COMMISSION_PAYOUT_AVG_MONTHS}, GETUTCDATE())
                AND ng.GeneratedDate < DATEFROMPARTS(YEAR(GETUTCDATE()), MONTH(GETUTCDATE()), 1)
              GROUP BY YEAR(ng.GeneratedDate), MONTH(ng.GeneratedDate)
            )
            SELECT ISNULL(AVG(CAST(MonthTotal AS DECIMAL(18, 2))), 0) AS AvgMonthly
            FROM MonthlyTotals
        `);

        const commAgg = `
      WITH CommAgg AS (
        SELECT
          c.PaymentId,
          SUM(c.Amount) AS CommissionAmount
        FROM oe.Commissions c
        WHERE c.AgentId = @viewerAgentId
          AND c.Status <> N'Deleted'
        GROUP BY c.PaymentId
      )`;

        // Member: prefer enrollment subscriber; if Payment.EnrollmentId is null, use household primary (same idea as billing list).
        const joinsAndWhereRecent = `
      FROM CommAgg ca
      INNER JOIN oe.Payments p ON p.PaymentId = ca.PaymentId
      LEFT JOIN oe.Agents sell_a ON p.AgentId = sell_a.AgentId
      LEFT JOIN oe.Users sell_u ON sell_a.UserId = sell_u.UserId
      LEFT JOIN oe.Groups pg ON p.GroupId = pg.GroupId
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      LEFT JOIN oe.Members m_h ON p.HouseholdId IS NOT NULL AND m_h.HouseholdId = p.HouseholdId AND m_h.RelationshipType = N'P'
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Users u_h ON m_h.UserId = u_h.UserId
      LEFT JOIN oe.Groups ig ON COALESCE(m.GroupId, m_h.GroupId) = ig.GroupId
      WHERE 1 = 1
        ${sellingFilter.clause}
    `;

        const recentPayReq = pool.request();
        recentPayReq.input('viewerAgentId', sql.UniqueIdentifier, viewerAgentId);
        sellingFilter.bind(recentPayReq);
        const recentCommissionRows = await recentPayReq.query(`
      ${commAgg}
      SELECT TOP 5
        p.PaymentId,
        p.PaymentDate,
        p.Amount,
        p.Status,
        p.PaymentMethod,
        p.AgentId AS SellingAgentId,
        ISNULL(sell_u.FirstName + N' ' + sell_u.LastName, N'') AS SellingAgentName,
        CASE WHEN p.AgentId IS NOT NULL AND p.AgentId <> @viewerAgentId THEN 1 ELSE 0 END AS IsUplinePayment,
        COALESCE(pg.GroupId, ig.GroupId) AS GroupId,
        COALESCE(pg.Name, ig.Name) AS GroupName,
        COALESCE(m.MemberId, m_h.MemberId) AS MemberId,
        COALESCE(
          NULLIF(LTRIM(RTRIM(ISNULL(u.FirstName + N' ' + u.LastName, N''))), N''),
          NULLIF(LTRIM(RTRIM(ISNULL(u_h.FirstName + N' ' + u_h.LastName, N''))), N'')
        ) AS MemberName,
        ca.CommissionAmount
      ${joinsAndWhereRecent}
      ORDER BY p.PaymentDate DESC
    `);

        const groupJoinBilling = `
      LEFT JOIN oe.Groups g ON g.GroupId = COALESCE(p.GroupId, m.GroupId)
    `;

        let whereBilling = 'WHERE p.TenantId = @tenantId';
        whereBilling += AGENT_BILLING_SCOPE_WHERE;
        whereBilling += ` ${sellingFilter.clause}`;

        const billingListReq = pool.request();
        billingListReq.input('tenantId', sql.UniqueIdentifier, tenantId);
        billingListReq.input('viewerAgentId', sql.UniqueIdentifier, viewerAgentId);
        sellingFilter.bind(billingListReq);
        const billingListResult = await billingListReq.query(`
      SELECT
        p.PaymentId,
        p.Amount,
        p.PaymentDate,
        p.Status,
        CASE WHEN p.GroupId IS NOT NULL AND gpm.Type IS NOT NULL THEN gpm.Type ELSE p.PaymentMethod END AS PaymentMethod,
        m.MemberId,
        COALESCE(p.GroupId, m.GroupId) AS GroupId,
        ISNULL(u.FirstName + ' ' + u.LastName, '') AS MemberName,
        g.Name AS GroupName
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON (p.HouseholdId IS NOT NULL AND m.HouseholdId = p.HouseholdId AND m.RelationshipType = 'P') OR e.MemberId = m.MemberId
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      ${groupJoinBilling}
      LEFT JOIN oe.GroupPaymentMethods gpm ON gpm.GroupId = p.GroupId AND gpm.IsDefault = 1 AND gpm.Status = 'Active'
      ${whereBilling}
      ORDER BY p.PaymentDate DESC
      OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY
    `);

        let whereUnresolved = 'WHERE p.TenantId = @tenantId';
        whereUnresolved += AGENT_BILLING_SCOPE_WHERE;
        whereUnresolved += UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE;
        whereUnresolved += ` ${sellingFilter.clause}`;

        const unresReq = pool.request();
        unresReq.input('tenantId', sql.UniqueIdentifier, tenantId);
        unresReq.input('viewerAgentId', sql.UniqueIdentifier, viewerAgentId);
        sellingFilter.bind(unresReq);
        const unresResult = await unresReq.query(`
      SELECT COUNT(*) AS Total
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON (p.HouseholdId IS NOT NULL AND m.HouseholdId = p.HouseholdId AND m.RelationshipType = 'P') OR e.MemberId = m.MemberId
      ${groupJoinBilling}
      LEFT JOIN oe.Agents a ON p.AgentId = a.AgentId OR e.AgentId = a.AgentId
      LEFT JOIN oe.Agencies ag ON a.AgencyId = ag.AgencyId
      ${UNRESOLVED_FAILED_PAYMENTS_FROM_P}
      ${whereUnresolved}
    `);

        const estimatedMonthlyCommission =
            Math.round(Number(payoutSumResult.recordset[0]?.AvgMonthly || 0) * 100) / 100;

        const recentCommissionPayments = (recentCommissionRows.recordset || []).map((r) => ({
            paymentId: r.PaymentId,
            paymentDate: r.PaymentDate,
            amount: Number(r.Amount || 0),
            status: r.Status,
            paymentMethod: r.PaymentMethod,
            sellingAgentId: r.SellingAgentId || null,
            sellingAgentName: (r.SellingAgentName && String(r.SellingAgentName).trim()) || null,
            isUplinePayment: r.IsUplinePayment === 1 || r.IsUplinePayment === true,
            groupId: r.GroupId || null,
            groupName: r.GroupName || null,
            memberId: r.MemberId || null,
            memberName: r.MemberName || null,
            commissionAmount: Number(r.CommissionAmount || 0)
        }));

        const recentBillingPayments = (billingListResult.recordset || []).map((r) => ({
            paymentId: r.PaymentId,
            amount: Number(r.Amount || 0),
            paymentDate: r.PaymentDate,
            status: r.Status,
            paymentMethod: r.PaymentMethod,
            memberId: r.MemberId ? String(r.MemberId) : null,
            groupId: r.GroupId ? String(r.GroupId) : null,
            memberName: r.MemberName || null,
            groupName: r.GroupName || null
        }));

        const unresolvedFailedPaymentCount = Number(unresResult.recordset[0]?.Total || 0);

        const dashboardData = {
            totalActiveHouseholds: householdsResult.recordset[0]?.totalActiveHouseholds || 0,
            monthlyPremiumAmount: Number(monthlyPremiumResult.recordset[0]?.monthlyPremiumAmount || 0),
            estimatedMonthlyCommission,
            failedPayments: unresolvedFailedPaymentCount,
            recentCommissions: recentCommissionPayments,
            recentCommissionPayments,
            recentBillingPayments,
            unresolvedFailedPaymentCount,
            metricsScope,
            /** True when headline totals aggregate more than the signed-in agent (downline or multi-agent agency). */
            metricsScopeIncludesOtherAgents: scopedAgentIds.length > 1,
            commissionPayoutAverageWindowMonths: COMMISSION_PAYOUT_AVG_MONTHS,
            agentCode
        };

        console.log('📊 Agent Dashboard Data:', {
            metricsScope,
            scopedCount: scopedAgentIds.length,
            households: dashboardData.totalActiveHouseholds,
            monthlyPremium: dashboardData.monthlyPremiumAmount,
            estimatedCommission: dashboardData.estimatedMonthlyCommission
        });

        res.json({ success: true, data: dashboardData });
    } catch (error) {
        console.error('Critical error fetching agent dashboard data:', error.message);
        res.status(500).json({ success: false, message: 'Server Error', code: 'AGENT_DASHBOARD_CRITICAL_ERROR' });
    }
});

/**
 * @route   GET /api/agents/members
 * @desc    Get all members assigned to the authenticated agent
 * @access  Private (Agent, Admin, SysAdmin)
 */
const agentMembersRouter = require('./agent/agent-members');
router.use('/members', agentMembersRouter);

const agentCommissionsRouter = require('./agent/agent-commissions');
router.use('/commissions', agentCommissionsRouter);

const agentTenantsRouter = require('./agent/agent-tenants');
router.use('/tenants', agentTenantsRouter);

// REMOVED: /products and /groups routes - these are now handled by /api/me/agent/* routes
// This prevents route conflicts and follows the proper separation of concerns

/**
 * @route   GET /api/agents/by-user/:userId
 * @desc    Get agent data by the agent's user id
 * @access  Private (Agent, Admin, SysAdmin)
 */
router.get('/by-user/:userId', authorize(['Agent', 'Admin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { userId } = req.params;

        if (!userId) {
            return res.status(400).json({ success: false, message: 'User ID is required' });
        }

        const pool = await getPool();
        const result = await pool.request()
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT
                    a.AgentId,
                    a.Status,
                    a.CommissionTier,
                    a.CommissionSettings,
                    a.AgencyId,
                    a.AgentCode,
                    a.AgentType,
                    a.ContractStartDate,
                    a.ContractEndDate,
                    a.NPN,
                    a.Address1,
                    a.Address2,
                    a.City,
                    a.State,
                    a.CommissionRole,
                    a.ZipCode,
                    a.SSNOrTaxID,
                    a.BusinessName,
                    u.UserId,
                    u.TenantId,
                    u.FirstName,
                    u.LastName,
                    u.Email,
                    u.PhoneNumber
                FROM oe.Agents a
                JOIN oe.Users u ON a.UserId = u.UserId
                WHERE a.UserId = @userId
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Agent not found' });
        }

        res.json({ success: true, data: result.recordset[0] });
    } catch (error) {
        console.error('Error fetching agent by user id:', error.message);
        res.status(500).json({ success: false, message: 'Server Error', code: 'AGENT_BY_USERID_ERROR' });
    }
});


/**
 * :id is the agent id to find the agent data for
 * @route   GET /api/agents/:id
 * @desc    Get agent profile details by AgentId
 * @access  Private (Agent can view own, Admins can view any)
 */
router.get('/:id', authorize(['SysAdmin', 'TenantAdmin', 'GroupAdmin', 'Agent']), requireTenantAccess, async (req, res) => {
    try {
        const authenticatedAgentId = getAgentId(req);
        const agentId = req.params.id;
        const userRoles = getUserRoles(req.user);

        // An agent can only view their own profile. Admins can view any.
        if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin') && authenticatedAgentId !== agentId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const pool = await getPool();
        const result = await pool.request()
            .input('agentId', sql.UniqueIdentifier, agentId)
            .query(`
                SELECT 
                    a.AgentId,
                    a.UserId,
                    u.FirstName,
                    u.LastName,
                    u.Email,
                    u.PhoneNumber,
                    a.LicenseNumber,
                    a.W9Stored,
                    a.BankingInfoStored
                FROM oe.Agents a
                JOIN oe.Users u ON a.UserId = u.UserId
                WHERE a.AgentId = @agentId
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Agent not found' });
        }

        res.json({ success: true, data: result.recordset[0] });

    } catch (error) {
        console.error('Error fetching agent profile:', error.message);
        res.status(500).json({ success: false, message: 'Server Error', code: 'AGENT_PROFILE_ERROR' });
    }
});

/**
 * @route   PUT /api/agents/:id
 * @desc    Update agent profile details
 * @access  Private (Agent can update own, Admins can update any)
 */
router.put('/:id', authorize(['Agent', 'Admin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const authenticatedAgentId = getAgentId(req);
        const requestedId = req.params.id;
        const userRole = req.user?.userType;
        const { FirstName, LastName, PhoneNumber } = req.body;

        // An agent can only update their own profile.
        if (userRole === 'Agent' && authenticatedAgentId !== requestedId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const pool = await getPool();
        
        // Update Users table
        await pool.request()
            .input('agentId', sql.UniqueIdentifier, requestedId)
            .input('FirstName', sql.NVarChar, FirstName)
            .input('LastName', sql.NVarChar, LastName)
            .input('PhoneNumber', sql.NVarChar, PhoneNumber)
            .query(`
                UPDATE oe.Users 
                SET FirstName = @FirstName, LastName = @LastName, PhoneNumber = @PhoneNumber, ModifiedDate = GETDATE()
                WHERE UserId = @agentId
            `);
        
        res.json({ success: true, message: 'Agent profile updated successfully.' });

    } catch (error) {
        console.error('Error updating agent profile:', error.message);
        res.status(500).json({ success: false, message: 'Server Error', code: 'AGENT_UPDATE_PROFILE_ERROR' });
    }
});

module.exports = router;
