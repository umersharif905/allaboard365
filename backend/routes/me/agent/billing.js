/**
 * Agent billing — payments for members/groups assigned to the logged-in agent only.
 * GET /api/me/agent/billing/payments
 * GET /api/me/agent/billing/filter-options
 * GET /api/me/agent/billing/payments/:paymentId/processor-fee-detail
 */
const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const { getPool, sql } = require('../../../config/database');
const DimeService = require('../../../services/dimeService');
const {
  UNRESOLVED_FAILED_PAYMENTS_FROM_P,
  UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE
} = require('../../../services/billingAuditUnresolvedFailedPayments');
const { sumUnresolvedFailedDedupedAmount } = require('../../../services/billingPaymentsUnresolvedFailedSummary.service');
const { buildSellingAgentPaymentFilter } = require('../../../utils/sellingAgentPaymentFilter');
const { excludeRecurringPlaceholderPaymentsFragment } = require('../../../constants/billingPaymentListSql');

const NO_LINKED_INVOICE_EXCLUDE_REFUNDED_UNLESS_STATUS =
  ` AND (p.Status IS NULL OR p.Status <> N'Refunded')`;

const getUserId = (req) => req.user?.UserId || req.user?.userId;

/** Member assigned to agent OR group (invoice context) assigned to agent. */
const AGENT_BILLING_SCOPE_WHERE = `
  AND (
    (m.MemberId IS NOT NULL AND m.AgentId = @viewerAgentId)
    OR EXISTS (
      SELECT 1 FROM oe.Groups gx
      WHERE gx.GroupId = COALESCE(p.GroupId, m.GroupId) AND gx.GroupId IS NOT NULL AND gx.AgentId = @viewerAgentId
    )
  )
`;

router.use(authorize(['Agent']));

/**
 * GET /payments — same query shape as tenant-admin billing, scoped to agent's members/groups.
 *
 * Optional `salesAgentFilter` (same semantics as commissions / oe.Payments.AgentId): when present,
 * further restricts rows by selling agent (me, full downline, agency, direct downlines, or a specific agent UUID).
 * When omitted, legacy behavior: no extra selling-agent filter (all payments visible for assigned members/groups).
 */
router.get('/payments', async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    const userId = getUserId(req);
    if (!tenantId || !userId) {
      return res.status(400).json({
        success: false,
        message: 'Tenant and user context required',
        error: { code: 'CONTEXT_REQUIRED' }
      });
    }

    const pool = await getPool();
    const agentReq = pool.request();
    agentReq.input('userId', sql.UniqueIdentifier, userId);
    const agentRow = await agentReq.query(`
      SELECT AgentId, AgencyId FROM oe.Agents WHERE UserId = @userId AND Status = N'Active'
    `);
    const viewerAgentId = agentRow.recordset?.[0]?.AgentId;
    const agencyId = agentRow.recordset?.[0]?.AgencyId || null;
    if (!viewerAgentId) {
      return res.status(404).json({
        success: false,
        message: 'Agent profile not found',
        error: { code: 'AGENT_NOT_FOUND' }
      });
    }

    const {
      status: statusRaw,
      groupId,
      memberId,
      startDate,
      endDate,
      page = '1',
      limit = '50',
      unresolvedFailedOnly: unresolvedFailedOnlyRaw,
      salesAgentFilter: salesAgentFilterRaw,
      noLinkedInvoice: noLinkedInvoiceRaw
    } = req.query;

    // Schedule placeholder rows are not surfaced to agents (no UI filter; ignore URL tampering).
    let status = statusRaw;
    if (typeof status === 'string' && status.trim().toLowerCase() === 'recurringscheduled') {
      status = undefined;
    }

    const sellingParamPresent = Object.prototype.hasOwnProperty.call(req.query, 'salesAgentFilter');

    let sellingFilter = null;
    if (sellingParamPresent) {
      sellingFilter = await buildSellingAgentPaymentFilter(
        req,
        pool,
        viewerAgentId,
        userId,
        agencyId,
        salesAgentFilterRaw
      );
      if (sellingFilter.error) {
        return res.status(sellingFilter.error).json({ success: false, message: sellingFilter.message });
      }
    }
    const unresolvedFailedOnly =
      unresolvedFailedOnlyRaw === '1' || unresolvedFailedOnlyRaw === 'true';
    const noLinkedInvoiceOnly =
      !unresolvedFailedOnly &&
      (noLinkedInvoiceRaw === '1' || noLinkedInvoiceRaw === 'true');
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    const extraJoins = unresolvedFailedOnly ? UNRESOLVED_FAILED_PAYMENTS_FROM_P : '';

    let whereWithoutStatus = 'WHERE p.TenantId = @tenantId';
    whereWithoutStatus += AGENT_BILLING_SCOPE_WHERE;
    if (unresolvedFailedOnly) {
      whereWithoutStatus += UNRESOLVED_FAILED_PAYMENTS_FULL_WHERE;
    } else {
      if (startDate) {
        whereWithoutStatus += ' AND CAST(p.PaymentDate AS DATE) >= @startDate';
      }
      if (endDate) {
        whereWithoutStatus += ' AND CAST(p.PaymentDate AS DATE) <= @endDate';
      }
    }
    if (groupId) {
      whereWithoutStatus += ' AND (p.GroupId = @groupId OR m.GroupId = @groupId)';
    }
    if (memberId) {
      whereWithoutStatus +=
        ' AND (m.MemberId = @memberId OR p.HouseholdId IN (SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId))';
    }
    if (sellingFilter) {
      // sellingFilter.clause starts with "AND ..." — must separate from preceding token (e.g. @endDate + AND → @endDateAND).
      whereWithoutStatus += ` ${sellingFilter.clause}`;
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
    }

    const groupJoin = `
      LEFT JOIN oe.Groups g ON g.GroupId = COALESCE(p.GroupId, m.GroupId)
    `;

    const countRequest = pool.request();
    countRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
    countRequest.input('viewerAgentId', sql.UniqueIdentifier, viewerAgentId);
    if (sellingFilter) sellingFilter.bind(countRequest);
    if (!unresolvedFailedOnly && status) countRequest.input('status', sql.NVarChar(50), status);
    if (groupId) countRequest.input('groupId', sql.UniqueIdentifier, groupId);
    if (memberId) countRequest.input('memberId', sql.UniqueIdentifier, memberId);
    if (!unresolvedFailedOnly && startDate) countRequest.input('startDate', sql.Date, startDate);
    if (!unresolvedFailedOnly && endDate) countRequest.input('endDate', sql.Date, endDate);

    const summaryRequest = pool.request();
    summaryRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
    summaryRequest.input('viewerAgentId', sql.UniqueIdentifier, viewerAgentId);
    if (sellingFilter) sellingFilter.bind(summaryRequest);
    if (groupId) summaryRequest.input('groupId', sql.UniqueIdentifier, groupId);
    if (memberId) summaryRequest.input('memberId', sql.UniqueIdentifier, memberId);
    if (!unresolvedFailedOnly && startDate) summaryRequest.input('startDate', sql.Date, startDate);
    if (!unresolvedFailedOnly && endDate) summaryRequest.input('endDate', sql.Date, endDate);

    const [countResult, summaryResult, failedUnresolvedDeduped] = await Promise.all([
      countRequest.query(`
      SELECT COUNT(*) AS Total
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON (p.HouseholdId IS NOT NULL AND m.HouseholdId = p.HouseholdId AND m.RelationshipType = 'P') OR e.MemberId = m.MemberId
      ${groupJoin}
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
      ${groupJoin}
      LEFT JOIN oe.Agents a ON p.AgentId = a.AgentId OR e.AgentId = a.AgentId
      LEFT JOIN oe.Agencies ag ON a.AgencyId = ag.AgencyId
      ${extraJoins}
      ${whereWithoutStatus}
    `),
      sumUnresolvedFailedDedupedAmount(pool, tenantId, {
        unresolvedFailedOnly: true,
        viewerAgentId: String(viewerAgentId),
        ...(sellingFilter
          ? { sellingPaymentWhere: sellingFilter.clause, bindSelling: sellingFilter.bind }
          : {})
      })
    ]);

    const total = countResult.recordset[0]?.Total ?? 0;
    const sumRow = summaryResult.recordset[0] || {};
    const returnedAmount = Number(sumRow.ReturnedAmount) || 0;
    const summary = {
      failedAmount: failedUnresolvedDeduped + returnedAmount,
      pendingAmount: Number(sumRow.PendingAmount) || 0,
      completedAmount: Number(sumRow.CompletedAmount) || 0,
      unresolvedFailedDedupedAmount: failedUnresolvedDeduped
    };

    const dataRequest = pool.request();
    dataRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
    dataRequest.input('viewerAgentId', sql.UniqueIdentifier, viewerAgentId);
    if (sellingFilter) sellingFilter.bind(dataRequest);
    dataRequest.input('limit', sql.Int, limitNum);
    dataRequest.input('offset', sql.Int, offset);
    if (!unresolvedFailedOnly && status) dataRequest.input('status', sql.NVarChar(50), status);
    if (groupId) dataRequest.input('groupId', sql.UniqueIdentifier, groupId);
    if (memberId) dataRequest.input('memberId', sql.UniqueIdentifier, memberId);
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
        p.ACHReturnCode,
        p.ACHReturnReason,
        p.ChargebackReason,
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
        ), 0) AS ProcessingFee
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

    let rows = (dataResult.recordset || []).map((r) => ({
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
      achReturnCode: r.ACHReturnCode ?? null,
      achReturnReason: r.ACHReturnReason ?? null,
      chargebackReason: r.ChargebackReason ?? null,
      nextBillingDate: r.NextBillingDate,
      memberId: r.MemberId ? String(r.MemberId) : null,
      groupId: r.GroupId ? String(r.GroupId) : null,
      memberName: r.MemberName || null,
      groupName: r.GroupName || null,
      agentName: r.AgentName || null,
      agencyName: r.AgencyName || null,
      productName: r.ProductName || null,
      attemptNumber: r.AttemptNumber != null ? Number(r.AttemptNumber) : null,
      consecutiveFailureCount: r.ConsecutiveFailureCount != null ? Number(r.ConsecutiveFailureCount) : null
    }));

    const processor = (r) => (r.processor || '').toString().toLowerCase();
    const dimeCalls = rows.map(async (r) => {
      if (processor(r) !== 'dime' || !r.processorTransactionId) return { paymentId: r.paymentId, dimeProcessorFee: null };
      const dateStr = r.paymentDate
        ? (r.paymentDate instanceof Date ? r.paymentDate.toISOString().slice(0, 10) : String(r.paymentDate).slice(0, 10))
        : null;
      if (!dateStr) return { paymentId: r.paymentId, dimeProcessorFee: null };
      const result = await DimeService.getProcessorFeeForTransaction(tenantId, r.processorTransactionId, dateStr);
      return {
        paymentId: r.paymentId,
        dimeProcessorFee: result.success && result.processorFee != null ? result.processorFee : null,
        dimeProcessorFeeComingSoon: result.comingSoon === true
      };
    });
    const dimeResults = await Promise.all(dimeCalls);
    const dimeByPaymentId = Object.fromEntries(
      dimeResults.map((d) => [String(d.paymentId), { fee: d.dimeProcessorFee, comingSoon: d.dimeProcessorFeeComingSoon }])
    );
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
    console.error('Error fetching agent billing payments:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payments',
      error: { message: error.message, code: 'PAYMENTS_ERROR' }
    });
  }
});

/**
 * GET /filter-options — groups and members assigned to this agent (for dropdowns).
 */
router.get('/filter-options', async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    const userId = getUserId(req);
    if (!tenantId || !userId) {
      return res.status(400).json({
        success: false,
        message: 'Tenant and user context required',
        error: { code: 'CONTEXT_REQUIRED' }
      });
    }

    const pool = await getPool();
    const ar = pool.request();
    ar.input('userId', sql.UniqueIdentifier, userId);
    const agentResult = await ar.query(`
      SELECT AgentId FROM oe.Agents WHERE UserId = @userId AND Status = N'Active'
    `);
    const viewerAgentId = agentResult.recordset?.[0]?.AgentId;
    if (!viewerAgentId) {
      return res.status(404).json({
        success: false,
        message: 'Agent profile not found',
        error: { code: 'AGENT_NOT_FOUND' }
      });
    }

    const request = pool.request();
    request.input('tenantId', sql.UniqueIdentifier, tenantId);
    request.input('viewerAgentId', sql.UniqueIdentifier, viewerAgentId);

    const [groupsRes, membersRes] = await Promise.all([
      request.query(`
        SELECT GroupId, Name
        FROM oe.Groups
        WHERE TenantId = @tenantId AND Status = N'Active' AND AgentId = @viewerAgentId
        ORDER BY Name
      `),
      pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('viewerAgentId', sql.UniqueIdentifier, viewerAgentId)
        .query(`
          SELECT m.MemberId, u.FirstName + ' ' + u.LastName AS Name, u.Email
          FROM oe.Members m
          INNER JOIN oe.Users u ON m.UserId = u.UserId
          WHERE u.TenantId = @tenantId AND m.AgentId = @viewerAgentId
          ORDER BY u.FirstName, u.LastName
        `)
    ]);

    res.json({
      success: true,
      data: {
        groups: (groupsRes.recordset || []).map((r) => ({ id: r.GroupId, label: r.Name, value: r.GroupId })),
        members: (membersRes.recordset || []).map((r) => ({
          id: r.MemberId,
          label: r.Name,
          value: r.MemberId,
          email: r.Email
        })),
        agents: [],
        agencies: []
      }
    });
  } catch (error) {
    console.error('Error fetching agent billing filter options:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch filter options',
      error: { message: error.message, code: 'FILTER_OPTIONS_ERROR' }
    });
  }
});

/**
 * GET /payments/:paymentId/processor-fee-detail
 */
router.get('/payments/:paymentId/processor-fee-detail', async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    const userId = getUserId(req);
    const { paymentId } = req.params;
    if (!tenantId || !userId || !paymentId) {
      return res.status(400).json({
        success: false,
        message: 'Tenant context and payment required',
        error: { code: 'BAD_REQUEST' }
      });
    }

    const pool = await getPool();
    const agentReq = pool.request();
    agentReq.input('userId', sql.UniqueIdentifier, userId);
    const agentRow = await agentReq.query(`
      SELECT AgentId FROM oe.Agents WHERE UserId = @userId AND Status = N'Active'
    `);
    const viewerAgentId = agentRow.recordset?.[0]?.AgentId;
    if (!viewerAgentId) {
      return res.status(404).json({ success: false, message: 'Agent profile not found', error: { code: 'AGENT_NOT_FOUND' } });
    }

    const scopeReq = pool.request();
    scopeReq.input('paymentId', sql.UniqueIdentifier, paymentId);
    scopeReq.input('tenantId', sql.UniqueIdentifier, tenantId);
    scopeReq.input('viewerAgentId', sql.UniqueIdentifier, viewerAgentId);
    const scopeResult = await scopeReq.query(`
      SELECT p.PaymentId
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON (p.HouseholdId IS NOT NULL AND m.HouseholdId = p.HouseholdId AND m.RelationshipType = 'P') OR e.MemberId = m.MemberId
      LEFT JOIN oe.Groups g ON g.GroupId = COALESCE(p.GroupId, m.GroupId)
      WHERE p.PaymentId = @paymentId AND p.TenantId = @tenantId
        AND (
          (m.MemberId IS NOT NULL AND m.AgentId = @viewerAgentId)
          OR (g.AgentId IS NOT NULL AND g.AgentId = @viewerAgentId)
        )
    `);
    if (!scopeResult.recordset?.length) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found',
        error: { code: 'NOT_FOUND' }
      });
    }

    const payResult = await pool
      .request()
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
      const dateStr = pay.PaymentDate
        ? (pay.PaymentDate instanceof Date ? pay.PaymentDate.toISOString().slice(0, 10) : String(pay.PaymentDate).slice(0, 10))
        : null;
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
    console.error('Error fetching agent processor fee detail:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch processor fee detail',
      error: { message: error.message, code: 'PROCESSOR_FEE_ERROR' }
    });
  }
});

module.exports = router;
