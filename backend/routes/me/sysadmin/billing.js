/**
 * Billing routes for SysAdmin
 * GET /api/me/sysadmin/billing/revenue?tenantId=...
 * GET /api/me/sysadmin/billing/projection?tenantId=...
 * GET /api/me/sysadmin/billing/payments?tenantId=...
 * GET /api/me/sysadmin/billing/recurring-payments?tenantId=...&agentId=&groupId=&memberType=
 * GET /api/me/sysadmin/billing/filter-options?tenantId=...
 * POST /api/me/sysadmin/billing/send-all-pending-invoice-emails?tenantId=... (optional tenant filter)
 * GET /api/me/sysadmin/billing/payments/:paymentId/commissions?tenantId=...
 * POST /api/me/sysadmin/billing/dime-payment-status-audit (body: tenantId, startDate/endDate or hoursBack, dryRun, limit, prioritizeSuccessfulFirst?, successRecheckDays?, secondaryLimit?)
 * GET /api/me/sysadmin/billing/members-missing-recurring-dime?tenantId=&limit=
 * GET /api/me/sysadmin/billing/member-portal-login-url?tenantId=
 * POST /api/me/sysadmin/billing/missing-recurring-sms (body or query: tenantId; body: memberIds[])
 * POST /api/me/sysadmin/billing/setup-missing-recurring (body: tenantId, dryRun?, memberIds?)
 * GET /api/me/sysadmin/billing/integration-errors?tenantId=&startDate=&endDate=&limit=
 * GET /api/me/sysadmin/billing/enrollment-wizard-payment-reports?tenantId=&startDate=&endDate=&limit=
 * GET /api/me/sysadmin/billing/enrollment-wizard-payment-reports?tenantId=&startDate=&endDate=&limit=
 * POST /api/me/sysadmin/billing/dime-list-sync (body: startDate, endDate, dryRun?, logRawStatus?)
 * GET /api/me/sysadmin/billing/audit-summary?tenantId=
 * POST /api/me/sysadmin/billing/audit-run (body: tenantId, audits[], ...)
 * GET /api/me/sysadmin/billing/audit-reports/latest?tenantId=
 * GET /api/me/sysadmin/billing/audit-report-recipients?tenantId=
 * PUT /api/me/sysadmin/billing/audit-report-recipients (body: { tenantId, emails })
 * All routes require tenantId query param except send-all-pending-invoice-emails, dime-list-sync, and audit-run (tenantId in body).
 */
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { authorize } = require('../../../middleware/auth');
const { getPool, sql } = require('../../../config/database');
const DimeService = require('../../../services/dimeService');
const PaymentAuditService = require('../../../services/paymentAudit.service');
const DimePaymentStatusAuditService = require('../../../services/dimePaymentStatusAudit.service');
const EnrollmentRecurringGapAuditService = require('../../../services/enrollmentRecurringGapAudit.service');
const PaymentWebhookIntegrationErrorsService = require('../../../services/paymentWebhookIntegrationErrors.service');
const {
  getAuditSummary,
  getMrrGapDrilldown,
  getMrrReconciliation
} = require('../../../services/billingAuditSummary.service');
const { getAuditDrilldown } = require('../../../services/billingAuditDrilldown.service');
const { runAudits } = require('../../../services/billingAuditRun.service');
const BillingAuditReportsService = require('../../../services/billingAuditReports.service');
const EnrollmentWizardPaymentReportsService = require('../../../services/enrollmentWizardPaymentReports.service');
const MissingRecurringOutreachService = require('../../../services/missingRecurringOutreach.service');
const { setupMissingRecurring } = require('../../../services/setupMissingRecurring.service');
const {
  parseWithInvalidTokens,
  serializeForDb
} = require('../../../services/billingAuditReportRecipients.service');
const { buildPersistedAuditSummary } = require('../../../services/billingAuditReportPersist.service');
const {
  UNRESOLVED_FAILED_PAYMENTS_FROM_P,
  UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE
} = require('../../../services/billingAuditUnresolvedFailedPayments');
const { sumUnresolvedFailedDedupedAmount } = require('../../../services/billingPaymentsUnresolvedFailedSummary.service');
const { excludeRecurringPlaceholderPaymentsFragment } = require('../../../constants/billingPaymentListSql');

const NO_LINKED_INVOICE_EXCLUDE_REFUNDED_UNLESS_STATUS =
  ` AND (p.Status IS NULL OR p.Status <> N'Refunded')`;

router.use(authorize(['SysAdmin']));

const MAX_AUDIT_REPORT_EMAILS = 25;

function toDateOnly(val) {
  if (val == null) return null;
  const d = val instanceof Date ? val : new Date(val);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function getTenantIdAndValidate(req, res) {
  const tenantId = req.query.tenantId;
  if (!tenantId) {
    res.status(400).json({
      success: false,
      message: 'tenantId query parameter is required',
      error: { message: 'tenantId required', code: 'TENANT_REQUIRED' }
    });
    return null;
  }
  const pool = await getPool();
  const check = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query('SELECT TenantId FROM oe.Tenants WHERE TenantId = @tenantId');
  if (!check.recordset || check.recordset.length === 0) {
    res.status(404).json({
      success: false,
      message: 'Tenant not found',
      error: { message: 'Tenant not found', code: 'TENANT_NOT_FOUND' }
    });
    return null;
  }
  return tenantId;
}

/**
 * GET /revenue?tenantId=...&startDate=...&endDate=...
 */
router.get('/revenue', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const { startDate, endDate } = req.query;
    const pool = await getPool();
    const request = pool.request();
    request.input('tenantId', sql.UniqueIdentifier, tenantId);

    let whereClause = 'WHERE p.TenantId = @tenantId AND p.Status = \'Completed\'';
    if (startDate) {
      whereClause += ' AND p.PaymentDate >= @startDate';
      request.input('startDate', sql.Date, startDate);
    }
    if (endDate) {
      whereClause += ' AND p.PaymentDate < DATEADD(day, 1, @endDate)';
      request.input('endDate', sql.Date, endDate);
    }

    const result = await request.query(`
      SELECT
        ISNULL(SUM(p.Amount), 0) AS TotalRevenue,
        COUNT(*) AS PaymentCount
      FROM oe.Payments p
      ${whereClause}
    `);

    const row = result.recordset[0] || { TotalRevenue: 0, PaymentCount: 0 };
    res.json({
      success: true,
      data: {
        totalRevenue: Number(row.TotalRevenue) || 0,
        paymentCount: Number(row.PaymentCount) || 0
      }
    });
  } catch (error) {
    console.error('Error fetching sysadmin billing revenue:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch revenue',
      error: { message: error.message, code: 'REVENUE_ERROR' }
    });
  }
});

/**
 * GET /projection?tenantId=...
 */
router.get('/projection', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const pool = await getPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT
          ROUND(ISNULL(SUM(CASE
            WHEN e.PaymentFrequency = 'Monthly' THEN e.PremiumAmount
            WHEN e.PaymentFrequency = 'Quarterly' THEN e.PremiumAmount / 3
            WHEN e.PaymentFrequency = 'Annual' THEN e.PremiumAmount / 12
            ELSE 0
          END), 0), 0) AS ProjectedRevenue,
          COUNT(DISTINCT e.EnrollmentId) AS EnrollmentCount
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        INNER JOIN oe.Users u_member ON m.UserId = u_member.UserId
        WHERE u_member.TenantId = @tenantId
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND e.ProductId IS NOT NULL
          AND e.ProductId != '00000000-0000-0000-0000-000000000000'
          AND e.EffectiveDate <= DATEADD(month, 1, EOMONTH(GETUTCDATE()))
          AND (e.TerminationDate IS NULL OR e.TerminationDate > EOMONTH(GETUTCDATE()))
      `);

    const row = result.recordset[0] || { ProjectedRevenue: 0, EnrollmentCount: 0 };
    res.json({
      success: true,
      data: {
        projectedRevenue: Number(row.ProjectedRevenue) || 0,
        enrollmentCount: Number(row.EnrollmentCount) || 0
      }
    });
  } catch (error) {
    console.error('Error fetching sysadmin billing projection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch projection',
      error: { message: error.message, code: 'PROJECTION_ERROR' }
    });
  }
});

/**
 * GET /payments?tenantId=...&status=...&groupId=...&memberId=...&agentId=...&agencyId=...&startDate=...&endDate=...&page=...&limit=...&unresolvedFailedOnly=...&noLinkedInvoice=...
 */
router.get('/payments', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const {
      status,
      groupId,
      memberId,
      agentId,
      agencyId,
      startDate,
      endDate,
      page = '1',
      limit = '50',
      unresolvedFailedOnly: unresolvedFailedOnlyRaw,
      commissionPaid: commissionPaidRaw,
      noLinkedInvoice: noLinkedInvoiceRaw
    } = req.query;
    const unresolvedFailedOnly =
      unresolvedFailedOnlyRaw === '1' || unresolvedFailedOnlyRaw === 'true';
    const noLinkedInvoiceOnly =
      !unresolvedFailedOnly &&
      (noLinkedInvoiceRaw === '1' || noLinkedInvoiceRaw === 'true');
    const commissionPaidFilter =
      commissionPaidRaw === 'paid' || commissionPaidRaw === 'unpaid' ? commissionPaidRaw : null;
    const commissionPaidClause = commissionPaidFilter
      ? commissionPaidFilter === 'paid'
        ? ` AND EXISTS (SELECT 1 FROM oe.Commissions c WHERE c.PaymentId = p.PaymentId AND c.Status <> 'Deleted')`
        : ` AND NOT EXISTS (SELECT 1 FROM oe.Commissions c WHERE c.PaymentId = p.PaymentId AND c.Status <> 'Deleted')`
      : '';
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    const pool = await getPool();
    const request = pool.request();
    request.input('tenantId', sql.UniqueIdentifier, tenantId);
    request.input('limit', sql.Int, limitNum);
    request.input('offset', sql.Int, offset);

    const extraJoins = unresolvedFailedOnly ? UNRESOLVED_FAILED_PAYMENTS_FROM_P : '';

    /** Date + group/member/agent/agency only — KPI pending/completed/returned (not status-scoped). */
    let whereWithoutStatus = 'WHERE p.TenantId = @tenantId';
    if (unresolvedFailedOnly) {
      whereWithoutStatus += UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE;
    } else {
      if (startDate) {
        whereWithoutStatus += ' AND CAST(p.PaymentDate AS DATE) >= @startDate';
        request.input('startDate', sql.Date, startDate);
      }
      if (endDate) {
        whereWithoutStatus += ' AND CAST(p.PaymentDate AS DATE) <= @endDate';
        request.input('endDate', sql.Date, endDate);
      }
    }
    if (groupId) {
      whereWithoutStatus += ' AND (p.GroupId = @groupId OR m.GroupId = @groupId)';
      request.input('groupId', sql.UniqueIdentifier, groupId);
    }
    if (memberId) {
      whereWithoutStatus +=
        ' AND (m.MemberId = @memberId OR p.HouseholdId IN (SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId))';
      request.input('memberId', sql.UniqueIdentifier, memberId);
    }
    if (agentId) {
      whereWithoutStatus += ' AND (p.AgentId = @agentId OR e.AgentId = @agentId)';
      request.input('agentId', sql.UniqueIdentifier, agentId);
    }
    if (agencyId) {
      whereWithoutStatus += ' AND ag.AgencyId = @agencyId';
      request.input('agencyId', sql.UniqueIdentifier, agencyId);
    }
    if (noLinkedInvoiceOnly) {
      whereWithoutStatus += ' AND p.InvoiceId IS NULL';
      const statusTrim = status != null && String(status).trim() !== '' ? String(status).trim() : '';
      if (!statusTrim) {
        whereWithoutStatus += NO_LINKED_INVOICE_EXCLUDE_REFUNDED_UNLESS_STATUS;
      }
    }

    whereWithoutStatus += excludeRecurringPlaceholderPaymentsFragment({
      status: unresolvedFailedOnly ? undefined : status,
      unresolvedFailedOnly
    });

    let whereClause = whereWithoutStatus;
    if (!unresolvedFailedOnly && status) {
      whereClause += ' AND p.Status = @status';
      request.input('status', sql.NVarChar(50), status);
    }
    whereClause += commissionPaidClause;

    const countRequest = pool.request();
    countRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
    if (!unresolvedFailedOnly && status) countRequest.input('status', sql.NVarChar(50), status);
    if (groupId) countRequest.input('groupId', sql.UniqueIdentifier, groupId);
    if (memberId) countRequest.input('memberId', sql.UniqueIdentifier, memberId);
    if (agentId) countRequest.input('agentId', sql.UniqueIdentifier, agentId);
    if (agencyId) countRequest.input('agencyId', sql.UniqueIdentifier, agencyId);
    if (!unresolvedFailedOnly && startDate) countRequest.input('startDate', sql.Date, startDate);
    if (!unresolvedFailedOnly && endDate) countRequest.input('endDate', sql.Date, endDate);

    const summaryRequest = pool.request();
    summaryRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
    if (groupId) summaryRequest.input('groupId', sql.UniqueIdentifier, groupId);
    if (memberId) summaryRequest.input('memberId', sql.UniqueIdentifier, memberId);
    if (agentId) summaryRequest.input('agentId', sql.UniqueIdentifier, agentId);
    if (agencyId) summaryRequest.input('agencyId', sql.UniqueIdentifier, agencyId);
    if (!unresolvedFailedOnly && startDate) summaryRequest.input('startDate', sql.Date, startDate);
    if (!unresolvedFailedOnly && endDate) summaryRequest.input('endDate', sql.Date, endDate);

    const [countResult, summaryResult, failedUnresolvedDeduped] = await Promise.all([
      countRequest.query(`
      SELECT COUNT(*) AS Total
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON (p.HouseholdId IS NOT NULL AND m.HouseholdId = p.HouseholdId AND m.RelationshipType = 'P') OR e.MemberId = m.MemberId
      LEFT JOIN oe.Agents a ON p.AgentId = a.AgentId OR e.AgentId = a.AgentId
      LEFT JOIN oe.Agencies ag ON a.AgencyId = ag.AgencyId
      ${extraJoins}
      ${whereClause}
    `),
      summaryRequest.query(`
      SELECT
        SUM(CASE WHEN p.Status = N'Pending' THEN CAST(ISNULL(p.Amount, 0) AS DECIMAL(18, 2)) ELSE 0 END) AS PendingAmount,
        SUM(CASE WHEN (p.Status IS NULL OR p.Status NOT IN (N'Failed', N'Returned', N'Pending')) THEN CAST(ISNULL(p.Amount, 0) AS DECIMAL(18, 2)) ELSE 0 END) AS CompletedAmount,
        SUM(CASE WHEN p.Status = N'Returned' THEN CAST(ISNULL(p.Amount, 0) AS DECIMAL(18, 2)) ELSE 0 END) AS ReturnedAmount
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON (p.HouseholdId IS NOT NULL AND m.HouseholdId = p.HouseholdId AND m.RelationshipType = 'P') OR e.MemberId = m.MemberId
      LEFT JOIN oe.Agents a ON p.AgentId = a.AgentId OR e.AgentId = a.AgentId
      LEFT JOIN oe.Agencies ag ON a.AgencyId = ag.AgencyId
      ${extraJoins}
      ${whereWithoutStatus}
    `),
      // Tenant-wide unresolved failed (matches Overview / Audit); not scoped by list date or other filters
      sumUnresolvedFailedDedupedAmount(pool, tenantId, { unresolvedFailedOnly: true })
    ]);
    const total = countResult.recordset[0]?.Total ?? 0;
    const sumRow = summaryResult.recordset[0] || {};
    const returnedAmount = Number(sumRow.ReturnedAmount) || 0;
    const summary = {
      failedAmount: failedUnresolvedDeduped + returnedAmount,
      pendingAmount: Number(sumRow.PendingAmount) || 0,
      completedAmount: Number(sumRow.CompletedAmount) || 0
    };

    const dataRequest = pool.request();
    dataRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
    dataRequest.input('limit', sql.Int, limitNum);
    dataRequest.input('offset', sql.Int, offset);
    if (!unresolvedFailedOnly && status) dataRequest.input('status', sql.NVarChar(50), status);
    if (groupId) dataRequest.input('groupId', sql.UniqueIdentifier, groupId);
    if (memberId) dataRequest.input('memberId', sql.UniqueIdentifier, memberId);
    if (agentId) dataRequest.input('agentId', sql.UniqueIdentifier, agentId);
    if (agencyId) dataRequest.input('agencyId', sql.UniqueIdentifier, agencyId);
    if (!unresolvedFailedOnly && startDate) dataRequest.input('startDate', sql.Date, startDate);
    if (!unresolvedFailedOnly && endDate) dataRequest.input('endDate', sql.Date, endDate);

    const dataResult = await dataRequest.query(`
      SELECT
        p.PaymentId,
        p.Amount,
        p.PaymentDate,
        p.Status,
        CASE WHEN p.GroupId IS NOT NULL AND gpm.Type IS NOT NULL THEN gpm.Type ELSE p.PaymentMethod END AS PaymentMethod,
        p.Processor,
        p.FailureReason,
        p.AttemptNumber,
        p.ConsecutiveFailureCount,
        p.ProcessorTransactionId,
        p.EnrollmentId,
        p.InvoiceId,
        li.InvoiceNumber AS LinkedInvoiceNumber,
        li.BillingPeriodStart AS LinkedInvoiceBillingPeriodStart,
        li.BillingPeriodEnd AS LinkedInvoiceBillingPeriodEnd,
        li.Status AS LinkedInvoiceStatus,
        p.LocationId,
        p.NextBillingDate,
        m.MemberId,
        COALESCE(p.GroupId, m.GroupId) AS GroupId,
        ISNULL(u.FirstName + ' ' + u.LastName, '') AS MemberName,
        g.Name AS GroupName,
        ISNULL(ua.FirstName + ' ' + ua.LastName, '') AS AgentName,
        ag.AgencyName AS AgencyName,
        pr.Name AS ProductName,
        COALESCE(p.ProcessingFeeAmount, (
          SELECT SUM(e3.PremiumAmount)
          FROM oe.Enrollments e3
          INNER JOIN oe.Members m3 ON e3.MemberId = m3.MemberId
          WHERE (p.GroupId IS NOT NULL AND m3.GroupId = p.GroupId OR (p.HouseholdId IS NOT NULL AND e3.HouseholdId = p.HouseholdId))
            AND e3.EnrollmentType = 'PaymentProcessingFee'
            AND e3.EffectiveDate <= p.PaymentDate
            AND (e3.TerminationDate IS NULL OR e3.TerminationDate > p.PaymentDate)
        ), 0) AS ProcessingFee,
        CAST(CASE WHEN EXISTS (
          SELECT 1 FROM oe.Commissions c
          WHERE c.PaymentId = p.PaymentId AND c.Status <> 'Deleted'
        ) THEN 1 ELSE 0 END AS BIT) AS CommissionPaid
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON (p.HouseholdId IS NOT NULL AND m.HouseholdId = p.HouseholdId AND m.RelationshipType = 'P') OR e.MemberId = m.MemberId
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Groups g ON g.GroupId = COALESCE(p.GroupId, m.GroupId)
      LEFT JOIN oe.GroupPaymentMethods gpm ON gpm.GroupId = p.GroupId AND gpm.IsDefault = 1 AND gpm.Status = 'Active'
      LEFT JOIN oe.Agents a ON p.AgentId = a.AgentId OR e.AgentId = a.AgentId
      LEFT JOIN oe.Users ua ON a.UserId = ua.UserId
      LEFT JOIN oe.Agencies ag ON a.AgencyId = ag.AgencyId
      LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
      LEFT JOIN oe.Invoices li ON li.InvoiceId = p.InvoiceId
      ${extraJoins}
      ${whereClause}
      ORDER BY p.PaymentDate DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    let rows = (dataResult.recordset || []).map(r => ({
      paymentId: r.PaymentId,
      amount: Number(r.Amount) || 0,
      paymentDate: r.PaymentDate,
      status: r.Status,
      paymentMethod: r.PaymentMethod,
      processor: r.Processor || null,
      processingFee: Number(r.ProcessingFee) || 0,
      processorTransactionId: r.ProcessorTransactionId ? String(r.ProcessorTransactionId).trim() : null,
      enrollmentId: r.EnrollmentId ? String(r.EnrollmentId) : null,
      invoiceId: r.InvoiceId ? String(r.InvoiceId) : null,
      linkedInvoiceNumber: r.LinkedInvoiceNumber || null,
      linkedInvoiceBillingPeriodStart: r.LinkedInvoiceBillingPeriodStart || null,
      linkedInvoiceBillingPeriodEnd: r.LinkedInvoiceBillingPeriodEnd || null,
      linkedInvoiceStatus: r.LinkedInvoiceStatus || null,
      locationId: r.LocationId ? String(r.LocationId) : null,
      failureReason: r.FailureReason,
      nextBillingDate: r.NextBillingDate,
      memberId: r.MemberId ? String(r.MemberId) : null,
      groupId: r.GroupId ? String(r.GroupId) : null,
      memberName: r.MemberName || null,
      groupName: r.GroupName || null,
      agentName: r.AgentName || null,
      agencyName: r.AgencyName || null,
      productName: r.ProductName || null,
      attemptNumber: r.AttemptNumber != null ? Number(r.AttemptNumber) : null,
      consecutiveFailureCount: r.ConsecutiveFailureCount != null ? Number(r.ConsecutiveFailureCount) : null,
      commissionPaid: r.CommissionPaid === true || r.CommissionPaid === 1
    }));

    const processor = (r) => (r.processor || '').toString().toLowerCase();
    const dimeCalls = rows.map(async (r) => {
      if (processor(r) !== 'dime' || !r.processorTransactionId) return { paymentId: r.paymentId, dimeProcessorFee: null, dimeProcessorFeeComingSoon: false };
      const dateStr = r.paymentDate ? (r.paymentDate instanceof Date ? r.paymentDate.toISOString().slice(0, 10) : String(r.paymentDate).slice(0, 10)) : null;
      if (!dateStr) return { paymentId: r.paymentId, dimeProcessorFee: null, dimeProcessorFeeComingSoon: false };
      const result = await DimeService.getProcessorFeeForTransaction(tenantId, r.processorTransactionId, dateStr);
      return {
        paymentId: r.paymentId,
        dimeProcessorFee: result.success && result.processorFee != null ? result.processorFee : null,
        dimeProcessorFeeComingSoon: result.comingSoon === true
      };
    });
    const dimeResults = await Promise.all(dimeCalls);
    const dimeByPaymentId = Object.fromEntries(dimeResults.map((d) => [String(d.paymentId), { fee: d.dimeProcessorFee, comingSoon: d.dimeProcessorFeeComingSoon }]));
    rows = rows.map((r) => {
      const d = dimeByPaymentId[String(r.paymentId)];
      return { ...r, dimeProcessorFee: d?.fee ?? null, dimeProcessorFeeComingSoon: d?.comingSoon === true };
    });

    res.json({
      success: true,
      data: rows,
      total: Number(total),
      summary
    });
  } catch (error) {
    console.error('Error fetching sysadmin billing payments:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payments',
      error: { message: error.message, code: 'PAYMENTS_ERROR' }
    });
  }
});

/**
 * GET /payments/:paymentId/processor-fee-detail?tenantId=... - Our processing fee (enrollments) and processor fee from DIME when applicable
 */
router.get('/payments/:paymentId/processor-fee-detail', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const { paymentId } = req.params;
    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: 'Payment required',
        error: { code: 'BAD_REQUEST' }
      });
    }
    const pool = await getPool();
    const payResult = await pool.request()
      .input('paymentId', sql.UniqueIdentifier, paymentId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT p.PaymentId, p.TenantId, p.Processor, p.ProcessorTransactionId, p.PaymentDate, p.GroupId, p.HouseholdId, p.ProcessingFeeAmount,
          COALESCE(p.ProcessingFeeAmount, (
            SELECT SUM(e3.PremiumAmount)
            FROM oe.Enrollments e3
            INNER JOIN oe.Members m3 ON e3.MemberId = m3.MemberId
            WHERE (p.GroupId IS NOT NULL AND m3.GroupId = p.GroupId OR (p.HouseholdId IS NOT NULL AND e3.HouseholdId = p.HouseholdId))
              AND e3.EnrollmentType = 'PaymentProcessingFee'
              AND e3.EffectiveDate <= p.PaymentDate
              AND (e3.TerminationDate IS NULL OR e3.TerminationDate > p.PaymentDate)
          ), 0) AS OurProcessingFee
        FROM oe.Payments p
        WHERE p.PaymentId = @paymentId AND p.TenantId = @tenantId
      `);
    const pay = payResult.recordset[0];
    if (!pay) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found',
        error: { code: 'NOT_FOUND' }
      });
    }
    const ourProcessingFee = Number(pay.OurProcessingFee) || 0;
    const processor = (pay.Processor || '').toString().toLowerCase();
    const processorTransactionId = pay.ProcessorTransactionId ? String(pay.ProcessorTransactionId).trim() : null;

    let processorFee = null;
    let processorName = null;
    let processorFeeComingSoon = false;
    if (processor === 'dime' && processorTransactionId) {
      const dateStr = pay.PaymentDate ? (pay.PaymentDate instanceof Date ? pay.PaymentDate.toISOString().slice(0, 10) : String(pay.PaymentDate).slice(0, 10)) : null;
      if (dateStr) {
        const dimeResult = await DimeService.getProcessorFeeForTransaction(tenantId, processorTransactionId, dateStr);
        if (dimeResult.success && dimeResult.processorFee != null) {
          processorFee = dimeResult.processorFee;
          processorName = dimeResult.processorName || 'DIME';
        }
        processorFeeComingSoon = dimeResult.comingSoon === true;
      }
    }

    res.json({
      success: true,
      data: {
        ourProcessingFee,
        processorName: processorName || (processor ? String(pay.Processor) : null),
        processorFee,
        processorFeeComingSoon: processorFeeComingSoon || false
      }
    });
  } catch (error) {
    console.error('Error fetching processor fee detail:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch processor fee detail',
      error: { message: error.message, code: 'PROCESSOR_FEE_ERROR' }
    });
  }
});

/**
 * GET /payments/:paymentId/audit?tenantId=...
 * Recomputes bucket allocations + JSON as-of the payment date (Amount is immutable).
 */
router.get('/payments/:paymentId/audit', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const { paymentId } = req.params;
    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: 'Payment required',
        error: { code: 'BAD_REQUEST' }
      });
    }

    const audit = await PaymentAuditService.computePaymentAllocation({ paymentId, tenantId });
    if (!audit) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found',
        error: { code: 'NOT_FOUND' }
      });
    }

    return res.json({ success: true, data: audit });
  } catch (error) {
    console.error('Error auditing payment (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to audit payment',
      error: { message: error.message, code: 'PAYMENT_AUDIT_ERROR' }
    });
  }
});

/**
 * GET /payments/:paymentId/audit/households?tenantId=...
 * For group payments: detailed breakdown per household (primary member) and per product with >0 premium.
 * For household payments: product breakdown for the household.
 */
router.get('/payments/:paymentId/audit/households', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const { paymentId } = req.params;
    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: 'Payment required',
        error: { code: 'BAD_REQUEST' }
      });
    }

    const audit = await PaymentAuditService.computePaymentAllocation({ paymentId, tenantId });
    if (!audit) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found',
        error: { code: 'NOT_FOUND' }
      });
    }

    if (audit.context === 'group' && audit.payment.GroupId && audit.billingPeriod) {
      const households = await PaymentAuditService.computeGroupHouseholdProductBreakdownForPeriod(
        audit.payment.GroupId,
        audit.billingPeriod.startDate,
        audit.billingPeriod.endDate
      );
      return res.json({
        success: true,
        data: {
          context: 'group',
          groupId: audit.payment.GroupId,
          billingPeriod: audit.billingPeriod,
          householdsCount: households.length,
          households
        }
      });
    }

    if (audit.payment.HouseholdId) {
      const products = await PaymentAuditService.computeHouseholdProductBreakdownAsOf(audit.payment.HouseholdId, audit.asOfDate);
      const fees = await PaymentAuditService.computeHouseholdFeeSummaryAsOf(audit.payment.HouseholdId, audit.asOfDate);
      return res.json({
        success: true,
        data: {
          context: 'household',
          householdId: audit.payment.HouseholdId,
          asOfDate: audit.asOfDate,
          fees,
          products
        }
      });
    }

    return res.status(400).json({
      success: false,
      message: 'Payment does not have a GroupId or HouseholdId context for breakdown',
      error: { code: 'NO_CONTEXT' }
    });
  } catch (error) {
    console.error('Error fetching payment household breakdown (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch payment household breakdown',
      error: { message: error.message, code: 'PAYMENT_AUDIT_BREAKDOWN_ERROR' }
    });
  }
});

/**
 * GET /payments/:paymentId/audit/households/:householdId/enrollments?tenantId=...
 * Returns oe.Enrollments line-by-line for a specific household within the audit window.
 * - Group payments: uses billingPeriod start/end
 * - Household payments: uses asOfDate
 */
router.get('/payments/:paymentId/audit/households/:householdId/enrollments', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const { paymentId, householdId } = req.params;
    if (!paymentId || !householdId) {
      return res.status(400).json({
        success: false,
        message: 'Payment and household required',
        error: { code: 'BAD_REQUEST' }
      });
    }

    const audit = await PaymentAuditService.computePaymentAllocation({ paymentId, tenantId });
    if (!audit) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found',
        error: { code: 'NOT_FOUND' }
      });
    }

    if (audit.context === 'group' && audit.payment.GroupId && audit.billingPeriod) {
      const enrollments = await PaymentAuditService.computeGroupHouseholdEnrollmentsLineItemsForPeriod(
        audit.payment.GroupId,
        householdId,
        audit.billingPeriod.startDate,
        audit.billingPeriod.endDate
      );
      return res.json({
        success: true,
        data: {
          context: 'group',
          groupId: audit.payment.GroupId,
          householdId,
          billingPeriod: audit.billingPeriod,
          enrollmentsCount: enrollments.length,
          enrollments
        }
      });
    }

    if (audit.context === 'household' && audit.payment.HouseholdId) {
      if (String(audit.payment.HouseholdId).toUpperCase() !== String(householdId).toUpperCase()) {
        return res.status(403).json({
          success: false,
          message: 'Household does not match payment household',
          error: { code: 'FORBIDDEN' }
        });
      }
      const enrollments = await PaymentAuditService.computeHouseholdEnrollmentsLineItemsAsOf(audit.payment.HouseholdId, audit.asOfDate);
      return res.json({
        success: true,
        data: {
          context: 'household',
          householdId: audit.payment.HouseholdId,
          asOfDate: audit.asOfDate,
          enrollmentsCount: enrollments.length,
          enrollments
        }
      });
    }

    return res.status(400).json({
      success: false,
      message: 'Payment does not have a GroupId or HouseholdId context for enrollments',
      error: { code: 'NO_CONTEXT' }
    });
  } catch (error) {
    console.error('Error fetching payment household enrollments (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch payment household enrollments',
      error: { message: error.message, code: 'PAYMENT_AUDIT_HOUSEHOLD_ENROLLMENTS_ERROR' }
    });
  }
});

/**
 * GET /payments/:paymentId/commissions?tenantId=...
 * Returns all oe.Commissions rows tied to the payment, joined with agent/agency details.
 */
router.get('/payments/:paymentId/commissions', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const { paymentId } = req.params;
    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: 'Payment required',
        error: { code: 'BAD_REQUEST' }
      });
    }

    const pool = await getPool();

    const check = await pool.request()
      .input('PaymentId', sql.UniqueIdentifier, paymentId)
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT PaymentId
        FROM oe.Payments
        WHERE PaymentId = @PaymentId AND TenantId = @TenantId
      `);
    if (!check.recordset || check.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found',
        error: { code: 'NOT_FOUND' }
      });
    }

    const result = await pool.request()
      .input('PaymentId', sql.UniqueIdentifier, paymentId)
      .query(`
        SELECT
          c.CommissionId,
          c.AgentId,
          a.FirstName AS AgentFirstName,
          a.LastName AS AgentLastName,
          a.Email AS AgentEmail,
          c.AgencyId,
          ag.AgencyName,
          c.Amount,
          c.Status,
          c.TransactionType,
          c.PeriodStartDate,
          c.PeriodEndDate,
          c.CreatedDate,
          c.ModifiedDate,
          c.HouseholdId,
          c.GroupId,
          c.EnrollmentId,
          c.SplitPartnerAgentId,
          sp.FirstName AS SplitPartnerFirstName,
          sp.LastName AS SplitPartnerLastName,
          c.SplitPercentage,
          c.IsPrimaryInSplit,
          c.OriginalCommissionId,
          c.AppliedToBalance
        FROM oe.Commissions c
        LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
        LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
        LEFT JOIN oe.Agents sp ON c.SplitPartnerAgentId = sp.AgentId
        WHERE c.PaymentId = @PaymentId
        ORDER BY c.CreatedDate ASC
      `);

    const commissions = (result.recordset || []).map((r) => ({
      commissionId: r.CommissionId,
      agentId: r.AgentId,
      agentName: [r.AgentFirstName, r.AgentLastName].filter(Boolean).join(' ').trim() || null,
      agentEmail: r.AgentEmail || null,
      agencyId: r.AgencyId,
      agencyName: r.AgencyName || null,
      amount: Number(r.Amount || 0),
      status: r.Status,
      transactionType: r.TransactionType,
      periodStartDate: r.PeriodStartDate,
      periodEndDate: r.PeriodEndDate,
      createdDate: r.CreatedDate,
      modifiedDate: r.ModifiedDate,
      householdId: r.HouseholdId,
      groupId: r.GroupId,
      enrollmentId: r.EnrollmentId,
      splitPartnerAgentId: r.SplitPartnerAgentId,
      splitPartnerName:
        [r.SplitPartnerFirstName, r.SplitPartnerLastName].filter(Boolean).join(' ').trim() || null,
      splitPercentage: r.SplitPercentage != null ? Number(r.SplitPercentage) : null,
      isPrimaryInSplit: r.IsPrimaryInSplit,
      originalCommissionId: r.OriginalCommissionId,
      appliedToBalance: r.AppliedToBalance != null ? Number(r.AppliedToBalance) : null
    }));

    const totalAmount = commissions.reduce((sum, c) => sum + (c.amount || 0), 0);

    return res.json({
      success: true,
      data: { commissions, totalAmount }
    });
  } catch (error) {
    console.error('Error fetching payment commissions (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch payment commissions',
      error: { message: error.message, code: 'PAYMENT_COMMISSIONS_ERROR' }
    });
  }
});

/**
 * POST /payments/:paymentId/zero-enrollment-snapshots?tenantId=...
 * Zeros out NetRate, OverrideRate, Commission, fee buckets, and JSON fields on the
 * oe.Payments row for this payment only. Amount is never changed.
 */
router.post('/payments/:paymentId/zero-enrollment-snapshots', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const { paymentId } = req.params;
    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: 'Payment required',
        error: { code: 'BAD_REQUEST' }
      });
    }

    const result = await PaymentAuditService.zeroPaymentSnapshotBuckets({
      paymentId,
      tenantId
    });

    return res.json({ success: true, data: { updated: result.updated } });
  } catch (error) {
    console.error('Error zeroing payment snapshot buckets (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to zero payment snapshot buckets',
      error: { message: error.message, code: 'ZERO_PAYMENT_SNAPSHOTS_ERROR' }
    });
  }
});

/**
 * POST /payments/:paymentId/correct?tenantId=...
 * Writes computed buckets + JSON to oe.Payments for the payment (never changes Amount).
 * If computedSum != Amount, requires { confirmMismatch: true }.
 */
router.post('/payments/:paymentId/correct', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const { paymentId } = req.params;
    const { confirmMismatch } = req.body || {};
    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: 'Payment required',
        error: { code: 'BAD_REQUEST' }
      });
    }

    const audit = await PaymentAuditService.computePaymentAllocation({ paymentId, tenantId });
    if (!audit) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found',
        error: { code: 'NOT_FOUND' }
      });
    }

    if (Number(audit?.totals?.amountDiff || 0) !== 0 && confirmMismatch !== true) {
      return res.status(409).json({
        success: false,
        message: 'Computed totals do not match payment Amount. Confirm mismatch to proceed.',
        error: { code: 'AMOUNT_MISMATCH' },
        data: audit
      });
    }

    const rows = await PaymentAuditService.applyCorrection({
      paymentId,
      tenantId,
      computed: audit.computed
    });

    if (!rows) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found',
        error: { code: 'NOT_FOUND' }
      });
    }

    console.log('✅ Payment corrected (sysadmin; buckets+JSON; Amount unchanged):', {
      paymentId,
      tenantId,
      userId: req.user?.UserId || null,
      amountDiff: audit?.totals?.amountDiff || 0
    });

    const refreshed = await PaymentAuditService.computePaymentAllocation({ paymentId, tenantId });
    return res.json({ success: true, data: refreshed });
  } catch (error) {
    console.error('Error correcting payment (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to correct payment',
      error: { message: error.message, code: 'PAYMENT_CORRECT_ERROR' }
    });
  }
});

/**
 * GET /recurring-payments?tenantId=...&agentId=&groupId=&memberType=all|group|individual
 */
router.get('/recurring-payments', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const { agentId, groupId, memberType = 'all' } = req.query;
    const pool = await getPool();
    const rows = [];

    if (memberType !== 'individual') {
      const groupReq = pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('groupId', sql.UniqueIdentifier, groupId || null)
        .input('agentId', sql.UniqueIdentifier, agentId || null);
      const groupResult = await groupReq.query(`
        SELECT
          grp.DimeScheduleId AS scheduleId,
          ISNULL(gl.Name, 'Primary') AS locationName,
          grp.NextBillingDate,
          grp.MonthlyAmount,
          grp.IsActive,
          grp.ModifiedDate AS CancelledDate,
          g.GroupId,
          g.Name AS groupName,
          g.AgentId AS agentId,
          ua.FirstName + ' ' + ua.LastName AS agentName
        FROM oe.GroupRecurringPaymentPlans grp
        LEFT JOIN oe.GroupLocations gl ON grp.LocationId = gl.LocationId
        INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
        LEFT JOIN oe.Agents a ON g.AgentId = a.AgentId
        LEFT JOIN oe.Users ua ON a.UserId = ua.UserId
        WHERE g.TenantId = @tenantId AND grp.DimeScheduleId IS NOT NULL
          AND (@groupId IS NULL OR grp.GroupId = @groupId)
          AND (@agentId IS NULL OR g.AgentId = @agentId)
        ORDER BY g.Name, gl.Name
      `);
      for (const r of (groupResult.recordset || [])) {
        rows.push({
          scheduleId: String(r.scheduleId),
          locationName: r.locationName,
          nextBillingDate: toDateOnly(r.NextBillingDate),
          monthlyAmount: parseFloat(r.MonthlyAmount || 0),
          isActive: r.IsActive === 1 || r.IsActive === true,
          cancelledDate: r.IsActive === 0 || r.IsActive === false ? toDateOnly(r.CancelledDate) : null,
          processor: 'DIME',
          context: 'group',
          groupId: r.GroupId ? String(r.GroupId) : null,
          groupName: r.groupName || null,
          memberId: null,
          memberName: null,
          agentId: r.agentId ? String(r.agentId) : null,
          agentName: r.agentName || null
        });
      }
    }

    if (memberType !== 'group') {
      const indReq = pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('agentId', sql.UniqueIdentifier, agentId || null);
      const indResult = await indReq.query(`
        SELECT
          sub.RecurringScheduleId AS scheduleId,
          sub.NextBillingDate,
          sub.Amount AS MonthlyAmount,
          m.MemberId,
          u.FirstName + ' ' + u.LastName AS memberName,
          m.AgentId AS agentId,
          ua.FirstName + ' ' + ua.LastName AS agentName
        FROM (
          SELECT RecurringScheduleId, Amount, NextBillingDate, HouseholdId,
            ROW_NUMBER() OVER (PARTITION BY RecurringScheduleId ORDER BY PaymentDate DESC) AS rn
          FROM oe.Payments
          WHERE RecurringScheduleId IS NOT NULL AND Status IN ('succeeded','APPROVAL','Completed')
        ) sub
        INNER JOIN oe.Members m ON sub.HouseholdId = m.HouseholdId AND m.RelationshipType = 'P'
        INNER JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Agents a ON m.AgentId = a.AgentId
        LEFT JOIN oe.Users ua ON a.UserId = ua.UserId
        WHERE sub.rn = 1 AND m.GroupId IS NULL AND u.TenantId = @tenantId
          AND (@agentId IS NULL OR m.AgentId = @agentId)
        ORDER BY u.FirstName, u.LastName
      `);
      for (const r of (indResult.recordset || [])) {
        rows.push({
          scheduleId: String(r.scheduleId),
          locationName: 'Individual',
          nextBillingDate: toDateOnly(r.NextBillingDate),
          monthlyAmount: parseFloat(r.MonthlyAmount || 0),
          isActive: true,
          cancelledDate: null,
          processor: 'DIME',
          context: 'individual',
          groupId: null,
          groupName: null,
          memberId: r.MemberId ? String(r.MemberId) : null,
          memberName: r.memberName || null,
          agentId: r.agentId ? String(r.agentId) : null,
          agentName: r.agentName || null
        });
      }
    }

    res.json({
      success: true,
      data: rows
    });
  } catch (error) {
    console.error('Error fetching sysadmin recurring payments:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch recurring payments',
      error: { message: error.message, code: 'RECURRING_PAYMENTS_ERROR' }
    });
  }
});

/**
 * GET /filter-options?tenantId=...
 */
router.get('/filter-options', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const pool = await getPool();
    const request = pool.request();
    request.input('tenantId', sql.UniqueIdentifier, tenantId);

    const [groupsRes, agentsRes, agenciesRes] = await Promise.all([
      request.query(`
        SELECT GroupId, Name
        FROM oe.Groups
        WHERE TenantId = @tenantId AND Status = 'Active'
        ORDER BY Name
      `),
      pool.request().input('tenantId', sql.UniqueIdentifier, tenantId).query(`
        SELECT a.AgentId, u.FirstName + ' ' + u.LastName AS Name, u.Email
        FROM oe.Agents a
        INNER JOIN oe.Users u ON a.UserId = u.UserId
        WHERE u.TenantId = @tenantId AND a.Status = 'Active'
        ORDER BY u.FirstName, u.LastName
      `),
      pool.request().input('tenantId', sql.UniqueIdentifier, tenantId).query(`
        SELECT ag.AgencyId, ag.AgencyName AS Name
        FROM oe.Agencies ag
        INNER JOIN oe.Agents a ON a.AgencyId = ag.AgencyId
        INNER JOIN oe.Users u ON a.UserId = u.UserId
        WHERE u.TenantId = @tenantId
        GROUP BY ag.AgencyId, ag.AgencyName
        ORDER BY ag.AgencyName
      `)
    ]);

    const membersRequest = pool.request();
    membersRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
    const membersRes = await membersRequest.query(`
      SELECT m.MemberId, u.FirstName + ' ' + u.LastName AS Name, u.Email
      FROM oe.Members m
      INNER JOIN oe.Users u ON m.UserId = u.UserId
      WHERE u.TenantId = @tenantId
      ORDER BY u.FirstName, u.LastName
    `);

    res.json({
      success: true,
      data: {
        groups: (groupsRes.recordset || []).map(r => ({ id: r.GroupId, label: r.Name, value: r.GroupId })),
        members: (membersRes.recordset || []).map(r => ({ id: r.MemberId, label: r.Name, value: r.MemberId, email: r.Email })),
        agents: (agentsRes.recordset || []).map(r => ({ id: r.AgentId, label: r.Name, value: r.AgentId, email: r.Email })),
        agencies: (agenciesRes.recordset || []).map(r => ({ id: r.AgencyId, label: r.Name, value: r.AgencyId }))
      }
    });
  } catch (error) {
    console.error('Error fetching sysadmin billing filter options:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch filter options',
      error: { message: error.message, code: 'FILTER_OPTIONS_ERROR' }
    });
  }
});

/**
 * POST /send-all-pending-invoice-emails?tenantId=... (optional)
 * Send pending invoice email for every group that has active enrollments for next month.
 * Calls the same send-sample-invoice-email endpoint per group (uses location contact email).
 * Use on localhost: start backend, log in as SysAdmin, then POST to this URL (e.g. from Postman or curl with cookie).
 */
router.post('/send-all-pending-invoice-emails', async (req, res) => {
  try {
    const { tenantId } = req.query;
    const pool = await getPool();

    let groupQuery = `
      SELECT DISTINCT g.GroupId, g.Name AS GroupName
      FROM oe.Groups g
      INNER JOIN oe.Members m ON m.GroupId = g.GroupId AND m.Status != 'Terminated'
      INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
        AND e.TerminationDate IS NULL
        AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL OR e.EnrollmentType IN ('PaymentProcessingFee', 'SystemFee', 'SetupFee'))
        AND CAST(e.EffectiveDate AS DATE) <= EOMONTH(DATEADD(MONTH, 1, CAST(GETUTCDATE() AS DATE)))
      WHERE g.Status = 'Active'
    `;
    const request = pool.request();
    if (tenantId) {
      groupQuery += ' AND g.TenantId = @tenantId';
      request.input('tenantId', sql.UniqueIdentifier, tenantId);
    }
    groupQuery += ' ORDER BY g.Name';

    const groupResult = await request.query(groupQuery);
    const groups = groupResult.recordset || [];

    if (groups.length === 0) {
      return res.json({
        success: true,
        message: 'No groups with active enrollments for next month',
        data: { groupsProcessed: 0, emailsSent: 0, results: [] }
      });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const cookie = req.headers.cookie || '';
    const results = [];

    for (const g of groups) {
      try {
        const resp = await axios.post(
          `${baseUrl}/api/groups/${g.GroupId}/billing/send-sample-invoice-email`,
          {},
          {
            headers: { Cookie: cookie },
            validateStatus: () => true,
            timeout: 60000
          }
        );
        const sent = resp.data?.data?.emailsSent ?? 0;
        const failed = resp.data?.data?.emailsFailed ?? 0;
        results.push({
          groupId: g.GroupId,
          groupName: g.GroupName,
          success: resp.status === 200 && resp.data?.success === true,
          statusCode: resp.status,
          emailsSent: sent,
          emailsFailed: failed,
          message: resp.data?.message || resp.data?.error || resp.statusText
        });
      } catch (err) {
        results.push({
          groupId: g.GroupId,
          groupName: g.GroupName,
          success: false,
          message: err.message || 'Request failed'
        });
      }
    }

    const totalSent = results.reduce((s, r) => s + (r.emailsSent || 0), 0);
    const totalFailed = results.reduce((s, r) => s + (r.emailsFailed || 0), 0);

    res.json({
      success: true,
      message: `Processed ${groups.length} group(s). Emails sent: ${totalSent}, failed: ${totalFailed}.`,
      data: {
        groupsProcessed: groups.length,
        emailsSent: totalSent,
        emailsFailed: totalFailed,
        results
      }
    });
  } catch (error) {
    console.error('Error sending all pending invoice emails:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send all pending invoice emails',
      error: error.message
    });
  }
});

/**
 * POST /dime-payment-status-audit
 * Body: { tenantId (or query), startDate?, endDate?, hoursBack? (1–168), dryRun?, limit?,
 *   prioritizeSuccessfulFirst?, successRecheckDays?, secondaryLimit? }
 */
router.post('/dime-payment-status-audit', async (req, res) => {
  try {
    const tenantId = req.body?.tenantId || req.query.tenantId;
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenantId is required in body or query',
        error: { code: 'TENANT_REQUIRED' }
      });
    }
    const pool = await getPool();
    const check = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query('SELECT TenantId FROM oe.Tenants WHERE TenantId = @tenantId');
    if (!check.recordset || check.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
        error: { code: 'TENANT_NOT_FOUND' }
      });
    }
    const body = req.body || {};
    const hoursBackOpt =
      body.hoursBack != null && body.hoursBack !== ''
        ? Math.min(168, Math.max(1, Number(body.hoursBack)))
        : null;
    const result = await DimePaymentStatusAuditService.runAudit({
      tenantId,
      startDate: hoursBackOpt ? null : toDateOnly(body.startDate),
      endDate: hoursBackOpt ? null : toDateOnly(body.endDate),
      hoursBack: hoursBackOpt,
      dryRun: body.dryRun !== false,
      limit: body.limit != null ? Number(body.limit) : undefined,
      prioritizeSuccessfulFirst: body.prioritizeSuccessfulFirst !== false,
      successRecheckDays: Math.min(366, Math.max(0, Number(body.successRecheckDays) || 0)),
      secondaryLimit: Math.min(1000, Math.max(0, Number(body.secondaryLimit) || 0))
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('dime-payment-status-audit (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to audit payment statuses against DIME',
      error: { message: error.message, code: 'DIME_STATUS_AUDIT_ERROR' }
    });
  }
});

/**
 * GET /members-missing-recurring-dime?tenantId=&limit=
 */
router.get('/members-missing-recurring-dime', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
    const result = await EnrollmentRecurringGapAuditService.runMembersMissingRecurringDime({
      tenantId,
      limit
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('members-missing-recurring-dime (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load members missing recurring DIME',
      error: { message: error.message, code: 'MEMBERS_MISSING_RECURRING_DIME_ERROR' }
    });
  }
});

/**
 * GET /member-portal-login-url?tenantId=
 */
router.get('/member-portal-login-url', async (req, res) => {
  try {
    const tenantId = req.query.tenantId;
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenantId query parameter is required',
        error: { code: 'TENANT_REQUIRED' }
      });
    }
    const pool = await getPool();
    const check = await pool
      .request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query('SELECT TenantId FROM oe.Tenants WHERE TenantId = @tenantId');
    if (!check.recordset || check.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
        error: { code: 'TENANT_NOT_FOUND' }
      });
    }
    const outreach = await MissingRecurringOutreachService.getMemberOutreachDefaults(pool, tenantId);
    return res.json({
      success: true,
      data: {
        memberPortalLoginUrl: outreach.memberPortalLoginUrl,
        tenantName: outreach.tenantName,
        supportEmail: outreach.supportEmail
      }
    });
  } catch (error) {
    console.error('member-portal-login-url (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to resolve member portal URL',
      error: { message: error.message, code: 'MEMBER_PORTAL_URL_ERROR' }
    });
  }
});

/**
 * POST /missing-recurring-sms
 * Body: { tenantId?, memberIds: string[] } — tenantId may also be in query.
 */
router.post('/missing-recurring-sms', async (req, res) => {
  try {
    const tenantId = req.body?.tenantId || req.query.tenantId;
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenantId is required in body or query',
        error: { code: 'TENANT_REQUIRED' }
      });
    }
    const pool = await getPool();
    const check = await pool
      .request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query('SELECT TenantId FROM oe.Tenants WHERE TenantId = @tenantId');
    if (!check.recordset || check.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
        error: { code: 'TENANT_NOT_FOUND' }
      });
    }
    const memberIds = req.body?.memberIds;
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'memberIds array is required'
      });
    }
    const data = await MissingRecurringOutreachService.queueMissingRecurringSms(pool, {
      tenantId,
      memberIds,
      createdBy: req.user?.UserId || null
    });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('missing-recurring-sms (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to queue SMS',
      error: { message: error.message, code: 'MISSING_RECURRING_SMS_ERROR' }
    });
  }
});

/**
 * POST /setup-missing-recurring
 * Body: { tenantId, dryRun?, memberIds?, limit? }
 */
router.post('/setup-missing-recurring', async (req, res) => {
  try {
    const tenantId = req.body?.tenantId || req.query.tenantId;
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenantId is required in body or query',
        error: { code: 'TENANT_REQUIRED' }
      });
    }
    const pool = await getPool();
    const check = await pool
      .request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query('SELECT TenantId FROM oe.Tenants WHERE TenantId = @tenantId');
    if (!check.recordset || check.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
        error: { code: 'TENANT_NOT_FOUND' }
      });
    }
    const { dryRun, memberIds, limit } = req.body || {};
    const data = await setupMissingRecurring({
      tenantId,
      dryRun: dryRun === true,
      memberIds: Array.isArray(memberIds) ? memberIds : undefined,
      limit
    });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('setup-missing-recurring (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to set up missing recurring payments',
      error: { message: error.message, code: 'SETUP_MISSING_RECURRING_ERROR' }
    });
  }
});

/**
 * GET /integration-errors?tenantId=...&startDate=&endDate=&limit=
 */
router.get('/integration-errors', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const { startDate, endDate, limit, resolutionStatus } = req.query;
    const rows = await PaymentWebhookIntegrationErrorsService.listPaymentWebhookErrors({
      tenantId,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      limit: limit != null ? Number(limit) : undefined,
      resolutionStatus: resolutionStatus || undefined
    });
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('integration-errors (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load integration errors',
      error: { message: error.message, code: 'INTEGRATION_ERRORS_ERROR' }
    });
  }
});

/**
 * POST /integration-errors/:integrationErrorId/resolve?tenantId=...
 * Body: { resolved: boolean }
 */
router.post('/integration-errors/:integrationErrorId/resolve', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const integrationErrorId = req.params.integrationErrorId;
    const resolved = req.body?.resolved !== false;
    const out = await PaymentWebhookIntegrationErrorsService.setPaymentWebhookErrorResolved({
      tenantId,
      integrationErrorId,
      resolved,
      resolvedByUserId: req.user?.UserId || null
    });
    if (out.updated === 0) {
      return res.status(404).json({
        success: false,
        message: 'Webhook error row not found for tenant',
        error: { code: 'NOT_FOUND' }
      });
    }
    return res.json({ success: true, data: { integrationErrorId, resolved } });
  } catch (error) {
    console.error('integration-errors resolve (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update integration error resolution',
      error: { message: error.message, code: 'INTEGRATION_ERRORS_RESOLVE_ERROR' }
    });
  }
});

/**
 * GET /enrollment-wizard-payment-reports?tenantId=...&startDate=&endDate=&limit=
 */
router.get('/enrollment-wizard-payment-reports', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const { startDate, endDate, limit } = req.query;
    const rows = await EnrollmentWizardPaymentReportsService.listEnrollmentWizardPaymentErrors({
      tenantId,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      limit: limit != null ? Number(limit) : undefined
    });
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('enrollment-wizard-payment-reports (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load enrollment wizard payment reports',
      error: { message: error.message, code: 'ENROLLMENT_WIZARD_PAYMENT_REPORTS_ERROR' }
    });
  }
});

/**
 * GET /audit-summary?tenantId=
 */
router.get('/audit-summary', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const data = await getAuditSummary(tenantId, {
      includePaymentJsonInvalid: process.env.BILLING_UI_OMIT_PAYMENT_JSON_AUDIT !== 'true'
    });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('audit-summary (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load billing audit summary',
      error: { message: error.message, code: 'AUDIT_SUMMARY_ERROR' }
    });
  }
});

/**
 * GET /audit-mrr-reconciliation?tenantId=
 */
router.get('/audit-mrr-reconciliation', async (req, res) => {
  try {
    const tenantId = req.query.tenantId || req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenantId required',
        error: { code: 'TENANT_REQUIRED' }
      });
    }
    const data = await getMrrReconciliation(tenantId);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('audit-mrr-reconciliation (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load MRR reconciliation',
      error: { message: error.message, code: 'AUDIT_MRR_RECONCILIATION_ERROR' }
    });
  }
});

/**
 * GET /audit-mrr-gap?tenantId=&limit=
 */
router.get('/audit-mrr-gap', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
    const data = await getMrrGapDrilldown(tenantId, { limit });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('audit-mrr-gap (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load MRR gap drilldown',
      error: { message: error.message, code: 'AUDIT_MRR_GAP_ERROR' }
    });
  }
});

/**
 * GET /audit-drilldown?tenantId=&type=unresolved_failed_payments|webhook_errors_30d|missing_recurring|payment_hold_enrollments|payment_json_invalid|orphan_payments&limit=
 */
router.get('/audit-drilldown', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const type = req.query.type;
    if (!type || typeof type !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'type query parameter is required',
        error: { code: 'TYPE_REQUIRED' }
      });
    }
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
    const data = await getAuditDrilldown(tenantId, type, limit);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('audit-drilldown (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load audit drilldown',
      error: { message: error.message, code: 'AUDIT_DRILLDOWN_ERROR' }
    });
  }
});

/**
 * POST /audit-run — body: { tenantId, audits[], startDate?, endDate?, hoursBack? (1–168), limit?, dryRun?, persistReport?,
 *   prioritizeSuccessfulFirst?, successRecheckDays?, secondaryLimit? }
 */
router.post('/audit-run', async (req, res) => {
  try {
    const sock = req.socket || req.connection;
    if (sock && typeof sock.setTimeout === 'function') {
      sock.setTimeout(3600000);
    }
    const tenantId = req.body?.tenantId || req.query.tenantId;
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenantId is required in body or query',
        error: { code: 'TENANT_REQUIRED' }
      });
    }
    const pool = await getPool();
    const check = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query('SELECT TenantId FROM oe.Tenants WHERE TenantId = @tenantId');
    if (!check.recordset || check.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
        error: { code: 'TENANT_NOT_FOUND' }
      });
    }
    const body = req.body || {};
    const audits = Array.isArray(body.audits) ? body.audits : [];
    if (audits.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'audits array is required',
        error: { code: 'AUDITS_REQUIRED' }
      });
    }
    const limit = body.limit != null ? Number(body.limit) : undefined;
    const dryRun = body.dryRun !== false;
    const hoursBackOpt =
      body.hoursBack != null && body.hoursBack !== ''
        ? Math.min(168, Math.max(1, Number(body.hoursBack)))
        : null;
    const data = await runAudits({
      tenantId,
      audits,
      startDate: toDateOnly(body.startDate),
      endDate: toDateOnly(body.endDate),
      hoursBack: hoursBackOpt,
      limit,
      dryRun,
      prioritizeSuccessfulFirst: body.prioritizeSuccessfulFirst !== false,
      successRecheckDays: Math.min(366, Math.max(0, Number(body.successRecheckDays) || 0)),
      secondaryLimit: Math.min(1000, Math.max(0, Number(body.secondaryLimit) || 0))
    });
    let report = null;
    if (body.persistReport === true) {
      const summarySnapshot = await getAuditSummary(tenantId);
      const persisted = await buildPersistedAuditSummary({
        tenantId,
        auditSummary: summarySnapshot,
        runPayload: data,
        runAtIso: new Date().toISOString()
      });
      const inserted = await BillingAuditReportsService.insertReport({
        tenantId,
        triggerName: 'manual',
        summary: persisted.summary,
        detail: persisted.detail,
        createdBy: req.user?.email || req.user?.Email || req.user?.sub || null
      });
      report = inserted;
    }
    return res.json({ success: true, data, report });
  } catch (error) {
    console.error('audit-run (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to run billing audits',
      error: { message: error.message, code: 'AUDIT_RUN_ERROR' }
    });
  }
});

/**
 * GET /audit-reports/latest?tenantId=
 */
router.get('/audit-reports/latest', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const data = await BillingAuditReportsService.getLatestReport(tenantId);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('audit-reports/latest (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load latest billing audit report',
      error: { message: error.message, code: 'AUDIT_REPORT_LATEST_ERROR' }
    });
  }
});

/**
 * GET /audit-report-recipients?tenantId=
 */
router.get('/audit-report-recipients', async (req, res) => {
  try {
    const tenantId = await getTenantIdAndValidate(req, res);
    if (tenantId == null) return;
    const pool = await getPool();
    const result = await pool
      .request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(
        `SELECT CAST(BillingAuditReportEmails AS NVARCHAR(MAX)) AS BillingAuditReportEmails
         FROM oe.Tenants WHERE TenantId = @tenantId`
      );
    const row = result.recordset && result.recordset[0];
    const emails = row && row.BillingAuditReportEmails != null ? String(row.BillingAuditReportEmails) : '';
    return res.json({ success: true, data: { emails } });
  } catch (error) {
    console.error('audit-report-recipients (sysadmin get):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load audit report recipients',
      error: { message: error.message, code: 'AUDIT_REPORT_RECIPIENTS_ERROR' }
    });
  }
});

/**
 * PUT /audit-report-recipients — body: { tenantId, emails }
 */
router.put('/audit-report-recipients', async (req, res) => {
  try {
    const tenantId = req.body?.tenantId || req.query.tenantId;
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenantId is required in body or query',
        error: { code: 'TENANT_REQUIRED' }
      });
    }
    const pool0 = await getPool();
    const check = await pool0.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query('SELECT TenantId FROM oe.Tenants WHERE TenantId = @tenantId');
    if (!check.recordset || check.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Tenant not found',
        error: { code: 'TENANT_NOT_FOUND' }
      });
    }

    const raw = req.body && req.body.emails != null ? String(req.body.emails) : '';
    const { valid, invalid } = parseWithInvalidTokens(raw);
    if (invalid.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Invalid email(s): ${invalid.join(', ')}`,
        error: { code: 'INVALID_EMAILS', invalid }
      });
    }
    if (valid.length > MAX_AUDIT_REPORT_EMAILS) {
      return res.status(400).json({
        success: false,
        message: `At most ${MAX_AUDIT_REPORT_EMAILS} addresses allowed`,
        error: { code: 'TOO_MANY_EMAILS' }
      });
    }
    const stored = serializeForDb(valid);
    const pool = await getPool();
    await pool
      .request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('emails', sql.NVarChar(sql.MAX), stored)
      .query(`UPDATE oe.Tenants SET BillingAuditReportEmails = @emails WHERE TenantId = @tenantId`);
    return res.json({ success: true, data: { emails: stored || '' } });
  } catch (error) {
    console.error('audit-report-recipients (sysadmin put):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to save audit report recipients',
      error: { message: error.message, code: 'AUDIT_REPORT_RECIPIENTS_SAVE_ERROR' }
    });
  }
});

/**
 * POST /dime-list-sync
 * Body: { startDate, endDate (YYYY-MM-DD), dryRun?: boolean (default true), logRawStatus?: boolean }
 * Proxies to oe_payment_manager POST /api/sync-payments (global for all tenants in DB).
 */
router.post('/dime-list-sync', async (req, res) => {
  try {
    const { startDate, endDate, dryRun, logRawStatus } = req.body || {};
    const sd = toDateOnly(startDate);
    const ed = toDateOnly(endDate);
    if (!sd || !ed) {
      return res.status(400).json({
        success: false,
        message: 'startDate and endDate are required (YYYY-MM-DD)',
        error: { code: 'INVALID_DATE_RANGE' }
      });
    }
    const paymentManagerUrl = process.env.PAYMENT_MANAGER_URL || 'http://localhost:7071';
    const apiKey = process.env.PAYMENT_MANAGER_ADMIN_API_KEY || process.env.ADMIN_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        success: false,
        message: 'Payment manager API key not configured (PAYMENT_MANAGER_ADMIN_API_KEY)',
        error: { code: 'PAYMENT_MANAGER_NOT_CONFIGURED' }
      });
    }
    const base = paymentManagerUrl.replace(/\/$/, '');
    const isDry = dryRun !== false;
    const qs = new URLSearchParams({
      startDate: sd,
      endDate: ed,
      dryRun: isDry ? 'true' : 'false',
      logRawStatus: logRawStatus ? 'true' : 'false'
    });
    const url = `${base}/api/sync-payments?${qs.toString()}`;
    let pmResponse;
    try {
      pmResponse = await axios.post(url, {}, {
        headers: { 'x-api-key': apiKey },
        timeout: 600000
      });
    } catch (pmError) {
      if (pmError.response) {
        const d = pmError.response.data || {};
        return res.status(502).json({
          success: false,
          message: d.error || d.message || `Payment manager returned ${pmError.response.status}`,
          data: d
        });
      }
      const isConnRefused = pmError.code === 'ECONNREFUSED' || pmError.cause?.code === 'ECONNREFUSED';
      const hint = isConnRefused
        ? ' Payment manager (oe_payment_manager) is not running locally, or PAYMENT_MANAGER_URL is wrong in production.'
        : '';
      return res.status(502).json({
        success: false,
        message: `Payment manager unreachable: ${pmError.message || pmError.code || 'Unknown error'}.${hint}`,
        error: { code: 'PAYMENT_MANAGER_UNREACHABLE' }
      });
    }
    return res.json({ success: true, data: pmResponse.data });
  } catch (error) {
    console.error('dime-list-sync (sysadmin):', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'DIME list sync failed',
      error: { message: error.message, code: 'DIME_LIST_SYNC_ERROR' }
    });
  }
});

module.exports = router;
