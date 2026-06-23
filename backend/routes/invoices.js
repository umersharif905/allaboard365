'use strict';

const express = require('express');
const internalRouter = express.Router();
const readRouter = express.Router();
const sql = require('mssql');
const { getPool } = require('../config/database');
const { authorize, getUserRoles } = require('../middleware/auth');
const { resolveMemberHouseholdLoginContext } = require('../services/memberHouseholdLoginContext.service');
const invoiceService = require('../services/invoiceService');
const { recalcStatusFromAmounts } = require('../services/householdCredits.service');
const {
  invoiceDueDateBeforeTenantLocalTodayPredicate,
  invoicePastDueOpenBalancePredicate,
  tenantLocalTodayDateSql
} = require('../utils/invoiceTenantCalendarSql');

const TENANT_INV_OVERDUE = invoicePastDueOpenBalancePredicate('i', 't');
const PaymentAuditService = require('../services/paymentAudit.service');
const {
  assertInvoiceReadAccess,
  effectiveInvoiceTenantScopeId,
  handleIndividualInvoicePdfRequest
} = require('../services/individualInvoicePdf.service');

/** Compare UUIDs from SQL (Buffer/string) safely */
function uuidStringsEqual(a, b) {
  if (a == null || b == null) return false;
  const norm = (x) => String(x).replace(/-/g, '').toLowerCase();
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// Multi-tenant helpers (same pattern as messageCenter.js / campaigns.js)
// ---------------------------------------------------------------------------

function wantsAllTenants(req) {
  const userRoles = getUserRoles(req.user);
  return userRoles.includes('SysAdmin') && (req.query.allTenants === 'true' || req.query.allTenants === '1');
}

function effectiveListTenantId(req) {
  const userRoles = getUserRoles(req.user);
  const q = req.query.tenantId;
  if (userRoles.includes('SysAdmin') && q) {
    return q;
  }
  return req.tenantId || req.user?.TenantId || null;
}

// ---------------------------------------------------------------------------
// Middleware: scheduled-job API key auth (for internal endpoints)
// ---------------------------------------------------------------------------

function requireScheduledJobApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (process.env.SCHEDULED_JOB_API_KEY && apiKey !== process.env.SCHEDULED_JOB_API_KEY) {
    return res.status(401).json({ success: false, message: 'Unauthorized - Invalid API key' });
  }
  next();
}

// ============================================================================
// Shared SQL fragments for primary-member name resolution
// ============================================================================

const MEMBER_NAME_SELECT = `u.FirstName AS MemberFirstName, u.LastName AS MemberLastName`;
const GROUP_NAME_SELECT = `g.Name AS GroupName`;
const MEMBER_NAME_JOIN = `LEFT JOIN oe.Members m ON i.HouseholdId = m.HouseholdId AND m.RelationshipType = 'P'
      LEFT JOIN oe.Users u ON m.UserId = u.UserId`;

// ============================================================================
// INTERNAL ENDPOINTS (called by oe_payment_manager / billing-nightly-job)
// Mounted WITHOUT authenticateMiddleware — uses API key auth instead.
// ============================================================================

/**
 * POST /api/invoices/resolve-for-payment
 */
internalRouter.post('/resolve-for-payment', requireScheduledJobApiKey, async (req, res) => {
  try {
    const { paymentId, householdId, tenantId, paymentDate, paymentAmount } = req.body;
    if (!paymentId || !householdId) {
      return res.status(400).json({ success: false, message: 'paymentId and householdId required' });
    }
    const result = await invoiceService.tryLinkPaymentToInvoice(paymentId, householdId, tenantId, paymentDate, paymentAmount);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/invoices/resolve-for-payment error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/invoices/nightly-run
 */
internalRouter.post('/nightly-run', requireScheduledJobApiKey, async (req, res) => {
  try {
    const stats = await invoiceService.runNightlyIndividualInvoices();
    return res.json({ success: true, data: stats });
  } catch (err) {
    console.error('POST /api/invoices/nightly-run error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/invoices/:invoiceId/fulfill
 */
internalRouter.post('/:invoiceId/fulfill', requireScheduledJobApiKey, async (req, res) => {
  try {
    const { paymentAmount } = req.body;
    const result = await invoiceService.fulfillInvoice(req.params.invoiceId, paymentAmount);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/invoices/:invoiceId/fulfill error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/invoices/:invoiceId/unfulfill
 */
internalRouter.post('/:invoiceId/unfulfill', requireScheduledJobApiKey, async (req, res) => {
  try {
    const { refundAmount } = req.body;
    const result = await invoiceService.unfulfillInvoice(req.params.invoiceId, refundAmount);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/invoices/:invoiceId/unfulfill error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ============================================================================
// READ ENDPOINTS (frontend, role-gated via authenticate + requireTenantAccess)
// Mounted WITH authenticateMiddleware + requireTenantAccess in app.js.
// Specific paths MUST come before /:invoiceId to avoid parameter capture.
// ============================================================================

/**
 * GET /api/invoices
 * Tenant-scoped list with filters. SysAdmin can pass allTenants=true.
 */
readRouter.get('/', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const pool = await getPool();
    const whereConditions = [];
    const request = pool.request();

    if (!wantsAllTenants(req)) {
      const scopeId = effectiveListTenantId(req);
      if (!scopeId) {
        return res.status(400).json({ success: false, message: 'Tenant context required' });
      }
      whereConditions.push('i.TenantId = @tenantId');
      request.input('tenantId', sql.UniqueIdentifier, scopeId);
    }

    let joinTenantForOverdue = false;
    if (req.query.status) {
      if (req.query.status === 'NotPaid') {
        whereConditions.push("i.Status != N'Paid'");
      } else if (req.query.status === 'Overdue') {
        whereConditions.push(invoicePastDueOpenBalancePredicate('i', 't'));
        joinTenantForOverdue = true;
      } else {
        whereConditions.push('i.Status = @status');
        request.input('status', sql.NVarChar(50), req.query.status);
      }
    }
    if (req.query.type) {
      whereConditions.push('i.InvoiceType = @type');
      request.input('type', sql.NVarChar(20), req.query.type);
    }
    if (req.query.overdue === 'true') {
      whereConditions.push(invoicePastDueOpenBalancePredicate('i', 't'));
      joinTenantForOverdue = true;
    }
    if (req.query.householdId) {
      whereConditions.push('i.HouseholdId = @householdId');
      request.input('householdId', sql.UniqueIdentifier, req.query.householdId);
    }
    if (req.query.memberId) {
      whereConditions.push('i.HouseholdId IN (SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId)');
      request.input('memberId', sql.UniqueIdentifier, req.query.memberId);
    }
    if (req.query.groupId) {
      whereConditions.push('i.GroupId = @groupId');
      request.input('groupId', sql.UniqueIdentifier, req.query.groupId);
    }
    if (req.query.startDate) {
      if (joinTenantForOverdue) {
        whereConditions.push('CAST(i.DueDate AS DATE) >= CAST(@startDate AS DATE)');
      } else {
        whereConditions.push('i.BillingPeriodStart >= @startDate');
      }
      request.input('startDate', sql.DateTime, new Date(req.query.startDate));
    }
    if (req.query.endDate) {
      if (joinTenantForOverdue) {
        whereConditions.push('CAST(i.DueDate AS DATE) <= CAST(@endDate AS DATE)');
      } else {
        whereConditions.push('i.BillingPeriodEnd <= @endDate');
      }
      request.input('endDate', sql.DateTime, new Date(req.query.endDate));
    }
    if (req.query.search) {
      whereConditions.push(`(i.InvoiceNumber LIKE @search
        OR u.FirstName LIKE @search OR u.LastName LIKE @search
        OR g.Name LIKE @search)`);
      request.input('search', sql.NVarChar(100), `%${req.query.search}%`);
    }

    const whereClause = whereConditions.length ? 'WHERE ' + whereConditions.join(' AND ') : '';
    const overdueSortBy = String(req.query.sortBy || 'most_overdue').trim().toLowerCase();
    let orderByClause = 'ORDER BY i.CreatedDate DESC';
    if (joinTenantForOverdue) {
      const tenantToday = tenantLocalTodayDateSql('t');
      if (overdueSortBy === 'highest_balance') {
        orderByClause = `ORDER BY i.BalanceDue DESC, DATEDIFF(day, CAST(i.DueDate AS DATE), ${tenantToday}) DESC, i.InvoiceNumber ASC`;
      } else if (overdueSortBy === 'newest') {
        orderByClause = 'ORDER BY i.CreatedDate DESC, i.DueDate ASC';
      } else {
        // most_overdue (default): longest past-due first, then highest balance
        orderByClause = `ORDER BY DATEDIFF(day, CAST(i.DueDate AS DATE), ${tenantToday}) DESC, i.BalanceDue DESC, i.InvoiceNumber ASC`;
      }
    }

    const page = parseInt(req.query.page) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize) || 50, 200);
    const offset = (page - 1) * pageSize;

    // BalanceDue is a persisted computed column factoring CreditAmount;
    // selecting it directly keeps credit-applied invoices in sync with the UI.
    const fromClause = `
      FROM oe.Invoices i
      ${joinTenantForOverdue ? 'LEFT JOIN oe.Tenants t ON t.TenantId = i.TenantId' : ''}
      ${MEMBER_NAME_JOIN}
      LEFT JOIN oe.Groups g ON i.GroupId = g.GroupId
    `;

    const summaryResult = await request.query(`
      SELECT
        COUNT(*) AS invoiceCount,
        COALESCE(SUM(i.TotalAmount), 0) AS totalAmount,
        COALESCE(SUM(i.PaidAmount), 0) AS totalPaid,
        COALESCE(SUM(i.BalanceDue), 0) AS totalBalanceDue
      ${fromClause}
      ${whereClause}
    `);

    const summaryRow = summaryResult.recordset[0] || {};

    const result = await request.query(`
      SELECT
        i.InvoiceId, i.InvoiceNumber, i.InvoiceType, i.Status,
        i.TotalAmount, i.PaidAmount,
        COALESCE(i.CreditAmount, 0) AS CreditAmount,
        i.BalanceDue,
        i.BillingPeriodStart, i.BillingPeriodEnd, i.DueDate,
        i.HouseholdId, i.GroupId, i.TenantId,
        m.MemberId,
        i.CreatedDate, i.ModifiedDate,
        ${MEMBER_NAME_SELECT},
        ${GROUP_NAME_SELECT},
        (SELECT COUNT(*) FROM oe.Payments p WHERE p.InvoiceId = i.InvoiceId) AS PaymentCount,
        COALESCE(pendingPay.PendingPaymentCount, 0) AS PendingPaymentCount,
        COALESCE(pendingPay.PendingPaymentAmount, 0) AS PendingPaymentAmount,
        latestPendingPay.LatestPendingPaymentDate,
        latestPendingPay.LatestPendingPaymentMethod,
        COALESCE(latestPendingPay.LatestPendingPaymentUnlinked, 0) AS LatestPendingPaymentUnlinked,
        remAgg.ReminderSendCount,
        lastBatch.LastReminderSentAt,
        COALESCE(remLast.LastHadEmail, 0) AS LastReminderHadEmail,
        COALESCE(remLast.LastHadSms, 0) AS LastReminderHadSms
      ${fromClause}
      OUTER APPLY (
        SELECT COUNT(CASE WHEN irl.Status = N'Queued' THEN 1 END) AS ReminderSendCount
        FROM oe.InvoiceReminderLog irl
        WHERE irl.InvoiceId = i.InvoiceId AND irl.TenantId = i.TenantId
      ) remAgg
      OUTER APPLY (
        SELECT TOP 1
          irl.AttemptNumber,
          MAX(irl.CreatedDate) AS LastReminderSentAt
        FROM oe.InvoiceReminderLog irl
        WHERE irl.InvoiceId = i.InvoiceId
          AND irl.TenantId = i.TenantId
          AND irl.Status = N'Queued'
        GROUP BY irl.AttemptNumber
        ORDER BY MAX(irl.CreatedDate) DESC
      ) lastBatch
      OUTER APPLY (
        SELECT
          MAX(CASE WHEN irl.Channel = N'Email' THEN 1 ELSE 0 END) AS LastHadEmail,
          MAX(CASE WHEN irl.Channel = N'SMS' THEN 1 ELSE 0 END) AS LastHadSms
        FROM oe.InvoiceReminderLog irl
        WHERE irl.InvoiceId = i.InvoiceId
          AND irl.TenantId = i.TenantId
          AND irl.Status = N'Queued'
          AND lastBatch.AttemptNumber IS NOT NULL
          AND irl.AttemptNumber = lastBatch.AttemptNumber
      ) remLast
      OUTER APPLY (
        SELECT
          COUNT(*) AS PendingPaymentCount,
          COALESCE(SUM(CAST(p.Amount AS DECIMAL(18, 2))), 0) AS PendingPaymentAmount
        FROM oe.Payments p
        WHERE p.Status = N'Pending'
          AND (
            p.InvoiceId = i.InvoiceId
            -- Unlinked pending payments that self-heal will link once settled:
            -- same household (individual) or group, payment date in the invoice's
            -- billing window (+15-day grace, mirrors selfHealInvoice).
            OR (
              p.InvoiceId IS NULL
              AND (
                (i.HouseholdId IS NOT NULL AND p.HouseholdId = i.HouseholdId AND p.GroupId IS NULL)
                OR (i.GroupId IS NOT NULL AND p.GroupId = i.GroupId)
              )
              AND p.PaymentDate >= i.BillingPeriodStart
              AND p.PaymentDate <= DATEADD(day, 15, i.BillingPeriodEnd)
            )
          )
      ) pendingPay
      OUTER APPLY (
        SELECT TOP 1
          p.PaymentDate AS LatestPendingPaymentDate,
          p.PaymentMethod AS LatestPendingPaymentMethod,
          CASE WHEN p.InvoiceId IS NULL THEN 1 ELSE 0 END AS LatestPendingPaymentUnlinked
        FROM oe.Payments p
        WHERE p.Status = N'Pending'
          AND (
            p.InvoiceId = i.InvoiceId
            OR (
              p.InvoiceId IS NULL
              AND (
                (i.HouseholdId IS NOT NULL AND p.HouseholdId = i.HouseholdId AND p.GroupId IS NULL)
                OR (i.GroupId IS NOT NULL AND p.GroupId = i.GroupId)
              )
              AND p.PaymentDate >= i.BillingPeriodStart
              AND p.PaymentDate <= DATEADD(day, 15, i.BillingPeriodEnd)
            )
          )
        ORDER BY p.PaymentDate DESC, p.CreatedDate DESC
      ) latestPendingPay
      ${whereClause}
      ${orderByClause}
      OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY
    `);

    const totalCount = parseInt(summaryRow.invoiceCount, 10) || 0;

    return res.json({
      success: true,
      data: result.recordset,
      pagination: {
        page,
        pageSize,
        total: totalCount,
      },
      summary: {
        invoiceCount: totalCount,
        totalAmount: parseFloat(summaryRow.totalAmount) || 0,
        totalPaid: parseFloat(summaryRow.totalPaid) || 0,
        totalBalanceDue: parseFloat(summaryRow.totalBalanceDue) || 0,
      },
    });
  } catch (err) {
    console.error('GET /api/invoices error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/invoices/me/member
 * Member's own invoices — looks up HouseholdId from oe.Members via UserId
 */
readRouter.get('/me/member', authorize(['Member', 'TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const userId = req.user?.UserId || req.user?.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'No user identity found' });
    }

    const pool = await getPool();

    let householdId;
    const roles = req.user?.roles || [];
    const isMemberOnly =
      roles.includes('Member') &&
      !roles.some((r) => ['TenantAdmin', 'SysAdmin'].includes(r));

    if (isMemberOnly || req.user?.currentRole === 'Member') {
      try {
        const ctx = await resolveMemberHouseholdLoginContext(userId, { delegateSpouse: true });
        householdId = ctx.householdId;
      } catch (ctxErr) {
        if (ctxErr.status === 403 || ctxErr.status === 404) {
          return res.status(ctxErr.status).json({ success: false, message: ctxErr.message });
        }
        throw ctxErr;
      }
    } else {
      const memberResult = await pool.request()
        .input('userId', sql.UniqueIdentifier, userId)
        .query(`SELECT TOP 1 HouseholdId FROM oe.Members WHERE UserId = @userId ORDER BY CASE WHEN RelationshipType = 'P' THEN 0 ELSE 1 END`);
      householdId = memberResult.recordset[0]?.HouseholdId;
    }

    if (!householdId) {
      return res.status(400).json({ success: false, message: 'No household found for user' });
    }

    const result = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`
        SELECT
          i.InvoiceId, i.InvoiceNumber, i.InvoiceType, i.Status,
          i.TotalAmount, i.PaidAmount,
          COALESCE(i.CreditAmount, 0) AS CreditAmount,
          i.BalanceDue,
          i.BillingPeriodStart, i.BillingPeriodEnd, i.DueDate,
          i.CreatedDate
        FROM oe.Invoices i
        WHERE i.HouseholdId = @householdId AND i.InvoiceType = N'Individual'
        ORDER BY i.BillingPeriodStart DESC
      `);

    return res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('GET /api/invoices/me/member error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/invoices/me/agent
 * Agent's members' invoices — looks up AgentId from oe.Agents via UserId
 */
readRouter.get('/me/agent', authorize(['Agent', 'TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const userId = req.user?.UserId || req.user?.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'No user identity found' });
    }

    const pool = await getPool();

    const agentResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`SELECT AgentId FROM oe.Agents WHERE UserId = @userId AND Status = 'Active'`);

    const agentId = agentResult.recordset[0]?.AgentId;
    if (!agentId) {
      return res.status(400).json({ success: false, message: 'No active agent profile found' });
    }

    const request = pool.request();
    request.input('agentId', sql.UniqueIdentifier, agentId);

    const whereConditions = [
      `(EXISTS (SELECT 1 FROM oe.Enrollments e WHERE e.HouseholdId = i.HouseholdId AND e.AgentId = @agentId)
        OR EXISTS (SELECT 1 FROM oe.Groups ag WHERE ag.GroupId = i.GroupId AND ag.AgentId = @agentId))`
    ];

    let joinTenantForOverdue = false;
    if (req.query.status) {
      if (req.query.status === 'Overdue') {
        whereConditions.push(invoicePastDueOpenBalancePredicate('i', 't'));
        joinTenantForOverdue = true;
      } else {
        whereConditions.push('i.Status = @status');
        request.input('status', sql.NVarChar(50), req.query.status);
      }
    }
    if (req.query.overdue === 'true') {
      whereConditions.push(invoicePastDueOpenBalancePredicate('i', 't'));
      joinTenantForOverdue = true;
    }

    const whereClause = 'WHERE ' + whereConditions.join(' AND ');

    const overdueSortBy = String(req.query.sortBy || 'most_overdue').trim().toLowerCase();
    let orderByClause = 'ORDER BY i.CreatedDate DESC';
    if (joinTenantForOverdue) {
      const tenantToday = tenantLocalTodayDateSql('t');
      if (overdueSortBy === 'highest_balance') {
        orderByClause = `ORDER BY i.BalanceDue DESC, DATEDIFF(day, CAST(i.DueDate AS DATE), ${tenantToday}) DESC, i.InvoiceNumber ASC`;
      } else if (overdueSortBy === 'newest') {
        orderByClause = 'ORDER BY i.CreatedDate DESC, i.DueDate ASC';
      } else {
        orderByClause = `ORDER BY DATEDIFF(day, CAST(i.DueDate AS DATE), ${tenantToday}) DESC, i.BalanceDue DESC, i.InvoiceNumber ASC`;
      }
    }

    const page = parseInt(req.query.page) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize) || 50, 200);
    const offset = (page - 1) * pageSize;

    const result = await request.query(`
      SELECT
        i.InvoiceId, i.InvoiceNumber, i.InvoiceType, i.Status,
        i.TotalAmount, i.PaidAmount,
        COALESCE(i.CreditAmount, 0) AS CreditAmount,
        i.BalanceDue,
        i.BillingPeriodStart, i.BillingPeriodEnd, i.DueDate,
        i.HouseholdId, i.GroupId,
        i.CreatedDate,
        ${MEMBER_NAME_SELECT},
        g.Name AS GroupName
      FROM oe.Invoices i
      ${joinTenantForOverdue ? 'LEFT JOIN oe.Tenants t ON t.TenantId = i.TenantId' : ''}
      ${MEMBER_NAME_JOIN}
      LEFT JOIN oe.Groups g ON i.GroupId = g.GroupId
      ${whereClause}
      ${orderByClause}
      OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY
    `);

    return res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('GET /api/invoices/me/agent error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/invoices/audit/overdue-unfulfilled
 * Count of invoices past due that are not paid or cancelled. For TenantBilling audit tab.
 */
readRouter.get('/audit/overdue-unfulfilled', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const scopeId = effectiveListTenantId(req);
    if (!scopeId && !wantsAllTenants(req)) {
      return res.status(400).json({ success: false, message: 'Tenant context required' });
    }

    const pool = await getPool();
    const summaryReq = pool.request();
    const detailReq = pool.request();
    let tenantFilter = '';

    if (!wantsAllTenants(req) && scopeId) {
      tenantFilter = 'AND i.TenantId = @tenantId';
      summaryReq.input('tenantId', sql.UniqueIdentifier, scopeId);
      detailReq.input('tenantId', sql.UniqueIdentifier, scopeId);
    }

    const result = await summaryReq.query(`
      SELECT
        COUNT(*) AS OverdueCount,
        COALESCE(SUM(i.BalanceDue), 0) AS TotalOutstanding
      FROM oe.Invoices i
      LEFT JOIN oe.Tenants t ON t.TenantId = i.TenantId
      WHERE ${TENANT_INV_OVERDUE}
        ${tenantFilter}
    `);

    const row = result.recordset[0] || { OverdueCount: 0, TotalOutstanding: 0 };

    const details = await detailReq.query(`
      SELECT TOP 50
        i.InvoiceId, i.InvoiceNumber, i.InvoiceType, i.Status,
        i.TotalAmount, i.PaidAmount,
        COALESCE(i.CreditAmount, 0) AS CreditAmount,
        i.BalanceDue,
        i.DueDate, i.BillingPeriodStart, i.BillingPeriodEnd,
        i.TenantId,
        ${MEMBER_NAME_SELECT},
        g.Name AS GroupName
      FROM oe.Invoices i
      LEFT JOIN oe.Tenants t ON t.TenantId = i.TenantId
      ${MEMBER_NAME_JOIN}
      LEFT JOIN oe.Groups g ON i.GroupId = g.GroupId
      WHERE ${TENANT_INV_OVERDUE}
        ${tenantFilter}
      ORDER BY i.DueDate ASC
    `);

    return res.json({
      success: true,
      data: {
        overdueCount: row.OverdueCount,
        totalOutstanding: parseFloat(row.TotalOutstanding) || 0,
        invoices: details.recordset,
      }
    });
  } catch (err) {
    console.error('GET /api/invoices/audit/overdue-unfulfilled error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/invoices/payout-flags?householdId=xxx
 * TenantAdmin / SysAdmin: commissions, vendor, or override payouts sent on NACHA per invoice.
 */
readRouter.get('/payout-flags', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const { householdId, groupId } = req.query;
    if (!householdId && !groupId) {
      return res.status(400).json({ success: false, message: 'householdId or groupId is required' });
    }

    const pool = await getPool();
    const tenantId = effectiveListTenantId(req);
    if (!tenantId && !getUserRoles(req.user).includes('SysAdmin')) {
      return res.status(400).json({ success: false, message: 'Tenant context required' });
    }

    const request = pool.request();
    const where = [];
    if (tenantId) {
      where.push('i.TenantId = @tenantId');
      request.input('tenantId', sql.UniqueIdentifier, tenantId);
    }
    if (householdId) {
      where.push('i.HouseholdId = @householdId');
      request.input('householdId', sql.UniqueIdentifier, householdId);
    }
    if (groupId) {
      where.push('i.GroupId = @groupId');
      request.input('groupId', sql.UniqueIdentifier, groupId);
    }

    const result = await request.query(`
      SELECT
        i.InvoiceId,
        MAX(CASE WHEN cp.CommissionId IS NOT NULL THEN 1 ELSE 0 END) AS HasCommissionPayout,
        MAX(CASE WHEN vd.NACHAPaymentDetailId IS NOT NULL THEN 1 ELSE 0 END) AS HasVendorPayout,
        MAX(CASE WHEN od.NACHAPaymentDetailId IS NOT NULL THEN 1 ELSE 0 END) AS HasOverridePayout
      FROM oe.Invoices i
      LEFT JOIN oe.Payments p ON p.InvoiceId = i.InvoiceId
      LEFT JOIN oe.Commissions cp ON cp.Status = N'Paid'
        AND cp.TransactionType IN (N'Advance', N'Commission')
        AND (
          cp.InvoiceId = i.InvoiceId
          OR cp.PaymentId = p.PaymentId
        )
      LEFT JOIN oe.NACHAPaymentDetails vd ON vd.RecipientEntityType = N'Vendor'
        AND vd.Amount > 0
        AND vd.ReissueOfNACHAPaymentDetailId IS NULL
        AND (vd.InvoiceId = i.InvoiceId OR vd.PaymentId = p.PaymentId)
        AND EXISTS (
          SELECT 1 FROM oe.NACHAGenerations g
          WHERE g.NACHAId = vd.NACHAId AND g.Status = N'Sent'
        )
      LEFT JOIN oe.NACHAPaymentDetails od ON od.RecipientEntityType = N'Tenant'
        AND od.Amount > 0
        AND od.ReissueOfNACHAPaymentDetailId IS NULL
        AND (od.InvoiceId = i.InvoiceId OR od.PaymentId = p.PaymentId)
        AND EXISTS (
          SELECT 1 FROM oe.NACHAGenerations g
          WHERE g.NACHAId = od.NACHAId AND g.Status = N'Sent'
        )
      WHERE ${where.join(' AND ')}
      GROUP BY i.InvoiceId
    `);

    /** @type {Record<string, { commissions: boolean, vendors: boolean, overrides: boolean }>} */
    const flags = {};
    for (const row of result.recordset || []) {
      flags[String(row.InvoiceId)] = {
        commissions: Number(row.HasCommissionPayout) === 1,
        vendors: Number(row.HasVendorPayout) === 1,
        overrides: Number(row.HasOverridePayout) === 1
      };
    }

    return res.json({ success: true, data: flags });
  } catch (err) {
    console.error('GET /api/invoices/payout-flags error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/invoices/:invoiceId/payout-details
 * TenantAdmin / SysAdmin: per-recipient payout lines with amounts and payout dates.
 */
readRouter.get('/:invoiceId/payout-details', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const invoiceId = req.params.invoiceId;
    const pool = await getPool();
    const request = pool.request();
    request.input('invoiceId', sql.UniqueIdentifier, invoiceId);

    let tenantFilter = '';
    if (!wantsAllTenants(req)) {
      const scopeId = effectiveInvoiceTenantScopeId(req);
      if (!scopeId) {
        return res.status(400).json({ success: false, message: 'Tenant context required' });
      }
      tenantFilter = 'AND i.TenantId = @tenantId';
      request.input('tenantId', sql.UniqueIdentifier, scopeId);
    }

    const invResult = await request.query(`
      SELECT i.InvoiceId, i.InvoiceNumber, i.TenantId
      FROM oe.Invoices i
      WHERE i.InvoiceId = @invoiceId ${tenantFilter}
    `);

    if (!invResult.recordset.length) {
      return res.status(404).json({ success: false, message: 'Resource not found or access denied' });
    }

    const invoiceRow = invResult.recordset[0];

    const [commissionResult, nachaResult] = await Promise.all([
      pool.request()
        .input('invoiceId', sql.UniqueIdentifier, invoiceId)
        .query(`
          SELECT
            c.CommissionId,
            c.Amount,
            c.TransactionType,
            c.ModifiedDate AS PayoutDate,
            COALESCE(
              NULLIF(LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, N''), N' ', ISNULL(u.LastName, N'')))), N''),
              NULLIF(LTRIM(RTRIM(ag.AgencyName)), N''),
              N'Agent'
            ) AS RecipientName
          FROM oe.Commissions c
          LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
          LEFT JOIN oe.Users u ON u.UserId = a.UserId
          LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
          LEFT JOIN oe.Payments p ON p.PaymentId = c.PaymentId
          WHERE c.Status = N'Paid'
            AND c.TransactionType IN (N'Advance', N'Commission')
            AND c.Amount > 0
            AND (
              c.InvoiceId = @invoiceId
              OR p.InvoiceId = @invoiceId
            )
          ORDER BY c.ModifiedDate DESC, RecipientName
        `),
      pool.request()
        .input('invoiceId', sql.UniqueIdentifier, invoiceId)
        .query(`
          SELECT
            d.NACHAPaymentDetailId,
            d.RecipientEntityType,
            d.Amount,
            ng.PayoutType,
            COALESCE(ng.SentDate, ng.GeneratedDate) AS PayoutDate,
            CASE
              WHEN d.RecipientEntityType = N'Vendor' THEN
                COALESCE(NULLIF(LTRIM(RTRIM(v.VendorName)), N''), N'Vendor')
              WHEN d.RecipientEntityType = N'Tenant' THEN
                COALESCE(NULLIF(LTRIM(RTRIM(t.Name)), N''), N'Tenant override')
              WHEN d.RecipientEntityType = N'Agent' THEN
                COALESCE(
                  NULLIF(LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, N''), N' ', ISNULL(u.LastName, N'')))), N''),
                  N'Agent'
                )
              WHEN d.RecipientEntityType = N'Agency' THEN
                COALESCE(NULLIF(LTRIM(RTRIM(ag.AgencyName)), N''), N'Agency')
              ELSE N'Recipient'
            END AS RecipientName
          FROM oe.NACHAPaymentDetails d
          INNER JOIN oe.NACHAGenerations ng ON ng.NACHAId = d.NACHAId
          LEFT JOIN oe.Payments p ON p.PaymentId = d.PaymentId
          LEFT JOIN oe.Vendors v ON d.RecipientEntityType = N'Vendor' AND v.VendorId = d.RecipientEntityId
          LEFT JOIN oe.Tenants t ON d.RecipientEntityType = N'Tenant' AND t.TenantId = d.RecipientEntityId
          LEFT JOIN oe.Agents a ON d.RecipientEntityType = N'Agent' AND a.AgentId = d.RecipientEntityId
          LEFT JOIN oe.Users u ON u.UserId = a.UserId
          LEFT JOIN oe.Agencies ag ON d.RecipientEntityType = N'Agency' AND ag.AgencyId = d.RecipientEntityId
          WHERE d.Amount > 0
            AND d.ReissueOfNACHAPaymentDetailId IS NULL
            AND ng.Status = N'Sent'
            AND (
              d.InvoiceId = @invoiceId
              OR p.InvoiceId = @invoiceId
            )
          ORDER BY PayoutDate DESC, RecipientName
        `)
    ]);

    const mapLine = (row, extra = {}) => ({
      recipientName: String(row.RecipientName || '').trim() || 'Recipient',
      amount: parseFloat(row.Amount) || 0,
      payoutDate: row.PayoutDate ? new Date(row.PayoutDate).toISOString() : null,
      ...extra
    });

    const commissions = (commissionResult.recordset || []).map((row) =>
      mapLine(row, { transactionType: row.TransactionType || null })
    );

    const vendors = [];
    const overrides = [];
    for (const row of nachaResult.recordset || []) {
      const line = mapLine(row, { payoutType: row.PayoutType || null });
      if (row.RecipientEntityType === 'Vendor') {
        vendors.push(line);
      } else if (row.RecipientEntityType === 'Tenant') {
        overrides.push(line);
      }
    }

    return res.json({
      success: true,
      data: {
        invoiceId: String(invoiceRow.InvoiceId),
        invoiceNumber: invoiceRow.InvoiceNumber || null,
        commissions,
        vendors,
        overrides
      }
    });
  } catch (err) {
    console.error('GET /api/invoices/:invoiceId/payout-details error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/invoices/backfill-breakdowns
 * Bulk-populate breakdown columns for all invoices that have NULLs.
 * Strategy:
 *   1. Copy from the single linked payment (fast SQL path)
 *   2. Recompute from enrollments for the remainder (uses computeInvoiceAllocation)
 */
readRouter.post('/backfill-breakdowns', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const tenantId = effectiveListTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant required' });
    }

    const pool = await getPool();
    const limit = parseInt(req.query.limit, 10) || 500;

    // Phase 1: Copy from single linked payment (pure SQL, fast)
    const phase1 = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        UPDATE i
        SET
            i.NetRate               = p.NetRate,
            i.OverrideRate          = p.OverrideRate,
            i.Commission            = p.Commission,
            i.SystemFees            = p.SystemFees,
            i.ProcessingFeeAmount   = p.ProcessingFeeAmount,
            i.SetupFee              = COALESCE(p.SetupFee, 0),
            i.ProductCommissions    = p.ProductCommissions,
            i.ProductVendorAmounts  = p.ProductVendorAmounts,
            i.ProductOwnerAmounts   = p.ProductOwnerAmounts,
            i.ModifiedDate          = GETUTCDATE()
        FROM oe.Invoices i
        INNER JOIN oe.Payments p ON p.InvoiceId = i.InvoiceId
            AND p.TransactionType = 'Payment'
        WHERE i.TenantId = @tenantId
          AND i.NetRate IS NULL
          AND i.OverrideRate IS NULL
          AND i.Commission IS NULL
          AND i.SystemFees IS NULL
          AND i.ProcessingFeeAmount IS NULL
          AND i.SetupFee IS NULL
          AND (
              SELECT COUNT(*)
              FROM oe.Payments p2
              WHERE p2.InvoiceId = i.InvoiceId
                AND p2.TransactionType = 'Payment'
          ) = 1
          AND p.NetRate IS NOT NULL
      `);
    const phase1Count = phase1.rowsAffected?.[0] || 0;

    // Phase 2: Recompute from enrollments for remaining invoices
    const remaining = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('limit', sql.Int, limit)
      .query(`
        SELECT TOP (@limit) InvoiceId
        FROM oe.Invoices
        WHERE TenantId = @tenantId
          AND NetRate IS NULL
          AND OverrideRate IS NULL
          AND Commission IS NULL
          AND SystemFees IS NULL
          AND ProcessingFeeAmount IS NULL
          AND SetupFee IS NULL
        ORDER BY CreatedDate DESC
      `);

    let phase2Count = 0;
    let phase2Errors = 0;
    for (const row of remaining.recordset) {
      try {
        const audit = await PaymentAuditService.computeInvoiceAllocation({
          invoiceId: row.InvoiceId,
          tenantId
        });
        if (audit?.computed) {
          await PaymentAuditService.applyInvoiceCorrection({
            invoiceId: row.InvoiceId,
            tenantId,
            computed: audit.computed
          });
          phase2Count++;
        }
      } catch (err) {
        phase2Errors++;
        console.error(`Backfill breakdown error for invoice ${row.InvoiceId}:`, err.message);
      }
    }

    // Count how many still remain
    const stillMissing = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT COUNT(*) AS cnt
        FROM oe.Invoices
        WHERE TenantId = @tenantId
          AND NetRate IS NULL
          AND OverrideRate IS NULL
          AND Commission IS NULL
          AND SystemFees IS NULL
          AND ProcessingFeeAmount IS NULL
          AND SetupFee IS NULL
      `);

    return res.json({
      success: true,
      data: {
        phase1CopiedFromPayments: phase1Count,
        phase2Recomputed: phase2Count,
        phase2Errors,
        remainingUnpopulated: stillMissing.recordset[0]?.cnt || 0
      }
    });
  } catch (err) {
    console.error('POST /api/invoices/backfill-breakdowns error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

const PAYMENT_INVOICE_LINK_ERROR_MESSAGES = {
  payment_not_found: 'Payment not found.',
  group_payments_use_group_billing_tools: 'Group-linked payments must be adjusted from group billing.',
  payment_has_no_household: 'Payment has no household — cannot link to an individual invoice.',
  only_transaction_type_payment_can_be_relinked: 'Only standard payment rows can be relinked.',
  refund_or_child_payment_cannot_be_relinked: 'Refund or follow-on payment rows cannot be relinked.',
  invoice_not_found: 'Invoice not found.',
  only_individual_invoices_allowed: 'Only individual invoices can be selected.',
  invoice_household_mismatch: 'Invoice does not belong to this payment’s household.',
  invoice_tenant_mismatch: 'Invoice tenant does not match the payment.',
  cannot_link_to_cancelled_invoice: 'Cannot link to a cancelled invoice.'
};

/**
 * POST /api/invoices/payments/:paymentId/invoice-link
 * Body: { invoiceId: string | null } — Individual invoice for same household/tenant, or null to unlink.
 * TenantAdmin scoped to tenant; SysAdmin may use allTenants + payment’s tenant.
 */
readRouter.post(
  '/payments/:paymentId/invoice-link',
  authorize(['SysAdmin', 'TenantAdmin']),
  async (req, res) => {
    try {
      const paymentId = req.params.paymentId;
      const invoiceId =
        req.body?.invoiceId === undefined || req.body?.invoiceId === ''
          ? null
          : String(req.body.invoiceId).trim() || null;

      const pool = await getPool();
      const payChk = await pool
        .request()
        .input('paymentId', sql.UniqueIdentifier, paymentId)
        .query(`SELECT TenantId FROM oe.Payments WHERE PaymentId = @paymentId`);

      if (!payChk.recordset?.length) {
        return res.status(404).json({ success: false, message: PAYMENT_INVOICE_LINK_ERROR_MESSAGES.payment_not_found });
      }

      const paymentTenantId = payChk.recordset[0].TenantId;
      const userRoles = getUserRoles(req.user);
      if (!userRoles.includes('SysAdmin')) {
        const scopeId = effectiveListTenantId(req);
        if (!scopeId || !uuidStringsEqual(scopeId, paymentTenantId)) {
          return res.status(403).json({ success: false, message: 'Not allowed for this tenant.' });
        }
      }

      const result = await invoiceService.reassignPaymentInvoiceLink({ paymentId, invoiceId });
      if (!result.ok) {
        const code = result.error || 'unknown';
        const msg = PAYMENT_INVOICE_LINK_ERROR_MESSAGES[code] || result.error || 'Failed to update payment link.';
        return res.status(400).json({ success: false, message: msg, code });
      }

      return res.json({
        success: true,
        data: {
          previousInvoiceId: result.previousInvoiceId ?? null,
          newInvoiceId: result.newInvoiceId ?? null,
          warnings: result.warnings,
          noOp: result.noOp === true
        }
      });
    } catch (err) {
      console.error('POST /api/invoices/payments/:paymentId/invoice-link error:', err);
      return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
    }
  }
);

/**
 * GET /api/invoices/:invoiceId/pdf
 * Individual invoice PDF only (on-demand). Inline disposition for print; ?download=1 for attachment.
 */
readRouter.get(
  '/:invoiceId/pdf',
  authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin', 'Member']),
  async (req, res) => {
    try {
      await handleIndividualInvoicePdfRequest(req, res, req.params.invoiceId);
    } catch (err) {
      console.error('GET /api/invoices/:invoiceId/pdf error:', err);
      res.status(500).json({ success: false, message: 'Failed to generate invoice PDF', error: err.message });
    }
  }
);

/**
 * GET /api/invoices/:invoiceId
 * Detail with linked payments. Tenant-scoped (unless SysAdmin allTenants).
 */
readRouter.get('/:invoiceId', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin', 'Member']), async (req, res) => {
  try {
    const pool = await getPool();
    const invoiceId = req.params.invoiceId;
    const request = pool.request();
    request.input('invoiceId', sql.UniqueIdentifier, invoiceId);

    let tenantFilter = '';
    if (!wantsAllTenants(req)) {
      const scopeId = effectiveInvoiceTenantScopeId(req);
      if (!scopeId) {
        return res.status(400).json({ success: false, message: 'Tenant context required' });
      }
      tenantFilter = 'AND i.TenantId = @tenantId';
      request.input('tenantId', sql.UniqueIdentifier, scopeId);
    }

    const invResult = await request.query(`
      SELECT
        i.*,
        u.FirstName AS MemberFirstName, u.LastName AS MemberLastName, u.Email AS MemberEmail,
        g.Name AS GroupName
      FROM oe.Invoices i
      LEFT JOIN oe.Members m ON i.HouseholdId = m.HouseholdId AND m.RelationshipType = 'P'
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Groups g ON i.GroupId = g.GroupId
      WHERE i.InvoiceId = @invoiceId ${tenantFilter}
    `);

    if (!invResult.recordset.length) {
      return res.status(404).json({ success: false, message: 'Resource not found or access denied' });
    }

    const invoiceRow = invResult.recordset[0];
    const allowed = await assertInvoiceReadAccess(req, pool, invoiceRow);
    if (!allowed) {
      return res.status(404).json({ success: false, message: 'Resource not found or access denied' });
    }

    const payments = await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .query(`
        SELECT PaymentId, Amount, Status, PaymentMethod, PaymentDate, CreatedDate
        FROM oe.Payments
        WHERE InvoiceId = @invoiceId
        ORDER BY PaymentDate DESC
      `);

    return res.json({
      success: true,
      data: {
        ...invoiceRow,
        payments: payments.recordset,
      }
    });
  } catch (err) {
    console.error('GET /api/invoices/:invoiceId error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/invoices/:invoiceId/summary
 * Financial comparison: expected vs actual
 */
readRouter.get('/:invoiceId/summary', authorize(['SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
  try {
    const data = await invoiceService.getInvoiceFinancialSummary(req.params.invoiceId);
    if (!data) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    return res.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/invoices/:invoiceId/summary error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * PATCH /api/invoices/:invoiceId
 * Manual adjustment of PaidAmount and/or Status by TenantAdmin/SysAdmin.
 */
readRouter.patch('/:invoiceId', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const { paidAmount, status } = req.body;

    if (paidAmount === undefined && !status) {
      return res.status(400).json({ success: false, message: 'Provide paidAmount and/or status to update.' });
    }

    const pool = await getPool();
    const tenantId = req.tenantId || req.user?.TenantId;

    const existing = await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT InvoiceId, TotalAmount, PaidAmount, Status,
               COALESCE(CreditAmount, 0) AS CreditAmount
        FROM oe.Invoices WHERE InvoiceId = @invoiceId AND TenantId = @tenantId
      `);

    if (!existing.recordset.length) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const inv = existing.recordset[0];
    const total = parseFloat(inv.TotalAmount) || 0;
    const credit = parseFloat(inv.CreditAmount) || 0;
    let newPaid = paidAmount !== undefined ? Number(paidAmount) : parseFloat(inv.PaidAmount) || 0;
    let newStatus = inv.Status;
    if (status) {
      newStatus = status;
    } else if (paidAmount !== undefined) {
      newStatus = recalcStatusFromAmounts(total, newPaid, credit, inv.Status);
    }

    const sets = ['ModifiedDate = GETUTCDATE()'];
    const updateReq = pool.request();
    updateReq.input('invoiceId', sql.UniqueIdentifier, invoiceId);
    updateReq.input('tenantId', sql.UniqueIdentifier, tenantId);
    updateReq.input('computedStatus', sql.NVarChar(50), newStatus);

    if (paidAmount !== undefined) {
      sets.push('PaidAmount = @paidAmount');
      updateReq.input('paidAmount', sql.Decimal(18, 2), newPaid);
    }
    if (status) {
      const validStatuses = ['Unpaid', 'Partial', 'Paid', 'Overdue', 'Cancelled'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
      }
      sets.push('Status = @status');
      updateReq.input('status', sql.NVarChar(50), status);
    } else if (paidAmount !== undefined) {
      sets.push('Status = @computedStatus');
    }

    sets.push(`PaymentReceivedDate = CASE
      WHEN @computedStatus = N'Paid' THEN COALESCE(PaymentReceivedDate, GETUTCDATE())
      ELSE NULL
    END`);

    await updateReq.query(`UPDATE oe.Invoices SET ${sets.join(', ')} WHERE InvoiceId = @invoiceId AND TenantId = @tenantId`);

    return res.json({ success: true, message: 'Invoice updated successfully' });
  } catch (err) {
    console.error('PATCH /api/invoices/:invoiceId error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /api/invoices/:invoiceId
 * Remove an Individual invoice (TenantAdmin / SysAdmin).
 * Blocks when payments are linked, paid balance is recorded, or credit ledger references the invoice.
 */
readRouter.delete('/:invoiceId', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const pool = await getPool();

    const invReq = pool.request().input('invoiceId', sql.UniqueIdentifier, invoiceId);
    let tenantFilterInv = '';
    if (!wantsAllTenants(req)) {
      const scopeId = effectiveListTenantId(req);
      if (!scopeId) {
        return res.status(400).json({ success: false, message: 'Tenant context required' });
      }
      tenantFilterInv = 'AND i.TenantId = @tenantId';
      invReq.input('tenantId', sql.UniqueIdentifier, scopeId);
    }

    const invResult = await invReq.query(`
      SELECT i.InvoiceId, i.TenantId, i.InvoiceType, i.PaidAmount
      FROM oe.Invoices i
      WHERE i.InvoiceId = @invoiceId ${tenantFilterInv}
    `);

    if (!invResult.recordset.length) {
      return res.status(404).json({ success: false, message: 'Invoice not found or access denied' });
    }

    const inv = invResult.recordset[0];
    if (String(inv.InvoiceType) !== 'Individual') {
      return res.status(400).json({
        success: false,
        message: 'Only individual (household) invoices can be deleted with this action.'
      });
    }

    const paidAmt = Number(inv.PaidAmount) || 0;
    if (paidAmt > 0.005) {
      return res.status(409).json({
        success: false,
        message:
          'Cannot delete this invoice while it has a recorded paid balance. Unlink or re-allocate payments to another invoice first.'
      });
    }

    const payCount = await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .query(`SELECT COUNT(*) AS c FROM oe.Payments WHERE InvoiceId = @invoiceId`);
    if (Number(payCount.recordset[0]?.c || 0) > 0) {
      return res.status(409).json({
        success: false,
        message:
          'This invoice has linked payments. Link those payments to a different invoice first, then try again.'
      });
    }

    const creditRefs = await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .query(`
        SELECT COUNT(*) AS c FROM oe.HouseholdCreditEntries
        WHERE TargetInvoiceId = @invoiceId OR SourceInvoiceId = @invoiceId
      `);
    if (Number(creditRefs.recordset[0]?.c || 0) > 0) {
      return res.status(409).json({
        success: false,
        message:
          'Account credit ledger entries reference this invoice. Resolve credit applications against this invoice first.'
      });
    }

    const delReq = pool.request().input('invoiceId', sql.UniqueIdentifier, invoiceId);
    let delTenantClause = '';
    if (!wantsAllTenants(req)) {
      delTenantClause = ' AND TenantId = @tenantId';
      delReq.input('tenantId', sql.UniqueIdentifier, inv.TenantId);
    }

    const delResult = await delReq.query(`
      DELETE FROM oe.Invoices
      WHERE InvoiceId = @invoiceId
        AND InvoiceType = N'Individual'
        ${delTenantClause}
    `);

    const affectedRows = Array.isArray(delResult.rowsAffected)
      ? delResult.rowsAffected[0]
      : delResult.rowsAffected;
    if (!affectedRows) {
      return res.status(404).json({ success: false, message: 'Invoice not found or access denied' });
    }

    return res.json({ success: true, message: 'Invoice deleted' });
  } catch (err) {
    const sqlNum = err && (err.number ?? err.originalError?.number);
    if (sqlNum === 547) {
      console.error('DELETE /api/invoices/:invoiceId blocked by FK:', err.message);
      return res.status(409).json({
        success: false,
        message:
          'This invoice cannot be deleted because related records still reference it. Remove those references first.'
      });
    }
    console.error('DELETE /api/invoices/:invoiceId error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/invoices/:invoiceId/resync-open-maintenance
 * Self-heal + reconcile + DIME recurring sync when totals change — same per-invoice
 * steps as runNightlyIndividualInvoices for open Individual invoices.
 */
readRouter.post(
  '/:invoiceId/resync-open-maintenance',
  authorize(['SysAdmin', 'TenantAdmin']),
  async (req, res) => {
    try {
      const { invoiceId } = req.params;
      const pool = await getPool();
      const request = pool.request().input('invoiceId', sql.UniqueIdentifier, invoiceId);
      let tenantFilter = '';
      if (!wantsAllTenants(req)) {
        const scopeId = effectiveListTenantId(req);
        if (!scopeId) {
          return res.status(400).json({ success: false, message: 'Tenant context required' });
        }
        tenantFilter = 'AND i.TenantId = @tenantId';
        request.input('tenantId', sql.UniqueIdentifier, scopeId);
      }
      const invResult = await request.query(`
        SELECT i.InvoiceId
        FROM oe.Invoices i
        WHERE i.InvoiceId = @invoiceId ${tenantFilter}
      `);
      if (!invResult.recordset.length) {
        return res.status(404).json({ success: false, message: 'Invoice not found or access denied' });
      }

      const result = await invoiceService.runIndividualInvoiceOpenMaintenanceNow(invoiceId);
      if (!result.ok) {
        return res.status(400).json({ success: false, message: result.message || 'Resync failed' });
      }
      if (result.skipped) {
        return res.json({
          success: true,
          skipped: true,
          message: result.message,
          data: { reason: result.reason, status: result.status }
        });
      }
      return res.json({ success: true, data: result.data });
    } catch (err) {
      console.error('POST /api/invoices/:invoiceId/resync-open-maintenance error:', err);
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ---------------------------------------------------------------------------
// Invoice Audit – mirrors the payment audit pattern
// ---------------------------------------------------------------------------

readRouter.get('/:invoiceId/audit', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const tenantId = effectiveListTenantId(req);
    if (!invoiceId || !tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant and invoice required' });
    }

    const audit = await PaymentAuditService.computeInvoiceAllocation({ invoiceId, tenantId });
    if (!audit) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    return res.json({ success: true, data: audit });
  } catch (err) {
    console.error('GET /api/invoices/:invoiceId/audit error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

readRouter.post('/:invoiceId/audit/correct', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const tenantId = effectiveListTenantId(req);
    if (!invoiceId || !tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant and invoice required' });
    }

    const audit = await PaymentAuditService.computeInvoiceAllocation({ invoiceId, tenantId });
    if (!audit) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    await PaymentAuditService.applyInvoiceCorrection({
      invoiceId,
      tenantId,
      computed: audit.computed
    });

    const refreshed = await PaymentAuditService.computeInvoiceAllocation({ invoiceId, tenantId });
    return res.json({ success: true, data: refreshed });
  } catch (err) {
    console.error('POST /api/invoices/:invoiceId/audit/correct error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = { internalRouter, readRouter };
