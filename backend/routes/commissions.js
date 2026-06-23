// routes/commissions.js - Complete Commission Management Routes with Tenant Support
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { getPool } = require('../config/database');
const { authenticate, authorize, getUserRoles } = require('../middleware/auth');
const requireTenantAccess = require('../middleware/requireTenantAccess');
const logger = require('../config/logger');
const commissionService = require('../services/commissionService');
const CommissionServiceAdvances = require('../services/commissionService.advances');
const commissionTopupService = require('../services/commissionTopup.service');
const commissionCalculatorService = require('../services/CommissionCalculatorService');
const achService = require('../services/ACHService');
const encryptionService = require('../services/encryptionService');
const { isUplineAncestor, getSelfAndDownlineAgentIds, getAgentIdsForAgency } = require('../utils/agentHierarchy');
const agencyAdmins = require('../utils/agencyAdmins');
const { redactSimulationForAgent } = require('../utils/redactAgentCommissionSimulation');
const MessageQueueService = require('../services/messageQueue.service');
const EmailTemplatesService = require('../services/emailTemplates.service');
const { buildTenantAppBaseUrl } = require('../utils/tenantAppUrl');
const {
  agentCommissionDueWindowSql,
  agentCommissionCreditBranchWindowSql,
} = require('../services/payoutFunding.service');

const TIER_LEVEL_SQL = sql.Decimal(9, 4);

const PAYMENT_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Optional body.paymentIds → AND p.PaymentId IN (...); invalid/empty → AND 1=0 */
function buildPaymentIdsInClause(paymentIds) {
  if (!Array.isArray(paymentIds) || paymentIds.length === 0) return '';
  const valid = [
    ...new Set(paymentIds.map((id) => String(id).trim()).filter((id) => PAYMENT_ID_UUID_RE.test(id)))
  ];
  if (valid.length === 0) return ' AND 1=0';
  const inList = valid.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
  return ` AND p.PaymentId IN (${inList})`;
}

// Apply authentication to all routes
router.use(authenticate);

/**
 * @route GET /api/commissions/missing
 * @desc Get count of payments without commission rows
 * @access SysAdmin, TenantAdmin (tenant-scoped)
 * @note Must be defined before parameterized routes to avoid conflicts
 */
router.get('/missing', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  console.log('🔍 /api/commissions/missing route hit');
  try {
    const pool = await getPool();
    const request = pool.request();
    const userRoles = getUserRoles(req.user);
    const isTenantAdmin = userRoles.includes('TenantAdmin');
    let tenantFilterClause = '';
    if (isTenantAdmin) {
      const tenantId = req.tenantId || req.user?.TenantId;
      if (!tenantId) {
        return res.status(400).json({ success: false, message: 'TenantId not found for TenantAdmin' });
      }
      request.input('TenantId', sql.UniqueIdentifier, tenantId);
      tenantFilterClause = ' AND a.TenantId = @TenantId';
    }

    const { startDate, endDate } = req.query;
    let dateFilterClause = '';
    if (startDate && endDate) {
      request.input('StartDate', sql.Date, startDate);
      request.input('EndDate', sql.Date, endDate);
      dateFilterClause = ' AND CAST(p.PaymentDate AS DATE) >= @StartDate AND CAST(p.PaymentDate AS DATE) <= @EndDate';
    }

    const result = await request.query(`
      SELECT COUNT(*) as MissingCount
      FROM oe.Payments p
      INNER JOIN oe.Agents a ON p.AgentId = a.AgentId
      -- Invoice-sourced payouts: prefer invoice breakdowns with payment fallback
      LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
      WHERE p.Status IN ('Completed', 'Draft', 'APPROVAL', 'SUCCESS', 'COMPLETED', 'succeeded')
        AND p.AgentId IS NOT NULL
        AND COALESCE(inv.Commission, p.Commission) IS NOT NULL
        AND COALESCE(inv.Commission, p.Commission) > 0
        AND a.Status = 'Active'
        AND NOT EXISTS (
          SELECT 1
          FROM oe.Commissions c
          WHERE c.Status != 'Deleted'
            AND (
              c.PaymentId = p.PaymentId
              OR (p.InvoiceId IS NOT NULL AND c.InvoiceId = p.InvoiceId)
              OR EXISTS (
                SELECT 1 FROM oe.Payments pLink
                WHERE pLink.InvoiceId = p.InvoiceId
                  AND pLink.PaymentId = c.PaymentId
              )
            )
        )
        ${tenantFilterClause}
        ${dateFilterClause}
    `);

    const missingCount = result.recordset[0]?.MissingCount || 0;

    res.json({
      success: true,
      missingCount: missingCount,
      message: `Found ${missingCount} invoice(s) without commissions`
    });

  } catch (error) {
    logger.error('Error checking missing commissions', { error: error.message, user: req.user?.UserId }, 'Commission');
    res.status(500).json({
      success: false,
      message: 'Failed to check for missing commissions'
    });
  }
});

/**
 * @route GET /api/commissions/missing-preview
 * @desc List settlements (oe.Payments) that would get commissions (same set as generate-missing), with linked invoice + agent
 * @access SysAdmin, TenantAdmin (tenant-scoped)
 */
router.get('/missing-preview', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    const isTenantAdmin = userRoles.includes('TenantAdmin');
    let tenantFilterClause = '';
    const reqObj = pool.request();
    if (isTenantAdmin) {
      const tenantId = req.tenantId || req.user?.TenantId;
      if (!tenantId) {
        return res.status(400).json({ success: false, message: 'TenantId not found for TenantAdmin' });
      }
      reqObj.input('TenantId', sql.UniqueIdentifier, tenantId);
      tenantFilterClause = ' AND a.TenantId = @TenantId';
    }

    const { startDate, endDate } = req.query;
    let dateFilterClause = '';
    if (startDate && endDate) {
      reqObj.input('StartDate', sql.Date, startDate);
      reqObj.input('EndDate', sql.Date, endDate);
      dateFilterClause = ' AND CAST(p.PaymentDate AS DATE) >= @StartDate AND CAST(p.PaymentDate AS DATE) <= @EndDate';
    }

    const result = await reqObj.query(`
      SELECT
        p.PaymentId,
        p.AgentId,
        p.PaymentDate,
        p.Amount,
        -- Invoice-sourced payouts: prefer invoice breakdowns with payment fallback
        COALESCE(inv.Commission, p.Commission) AS Commission,
        p.Status AS PaymentStatus,
        p.InvoiceId,
        inv.InvoiceNumber,
        inv.Status AS InvoiceStatus,
        inv.PaymentReceivedDate AS InvoicePaymentReceivedDate,
        u.FirstName + ' ' + u.LastName AS AgentName,
        ISNULL(a.CommissionTierLevel, 0) AS AgentCommissionTierLevel,
        CASE
          WHEN p.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN pg.Name
          ELSE (
            SELECT TOP 1 um.FirstName + ' ' + um.LastName
            FROM oe.Members mm
            INNER JOIN oe.Users um ON mm.UserId = um.UserId
            WHERE mm.HouseholdId = p.HouseholdId
            ORDER BY CASE WHEN mm.RelationshipType = 'P' THEN 0 ELSE 1 END
          )
        END AS ClientName,
        p.GroupId AS GroupId,
        (SELECT TOP 1 mm.MemberId FROM oe.Members mm INNER JOIN oe.Users um ON mm.UserId = um.UserId WHERE mm.HouseholdId = p.HouseholdId ORDER BY CASE WHEN mm.RelationshipType = 'P' THEN 0 ELSE 1 END) AS PrimaryMemberId,
        (
          SELECT COUNT(DISTINCT e2.ProductId)
          FROM oe.Enrollments e2
          INNER JOIN oe.Products pr ON e2.ProductId = pr.ProductId
          WHERE (
            (p.HouseholdId IS NOT NULL AND e2.HouseholdId = p.HouseholdId)
            OR (p.GroupId IS NOT NULL AND EXISTS (SELECT 1 FROM oe.Members m WHERE m.MemberId = e2.MemberId AND m.GroupId = p.GroupId))
          )
            AND e2.ProductId IS NOT NULL
            AND e2.ProductId != '00000000-0000-0000-0000-000000000000'
            AND e2.CreatedDate <= p.PaymentDate
            AND (e2.TerminationDate IS NULL OR e2.TerminationDate > p.PaymentDate)
            AND (e2.TerminationDate IS NULL OR e2.TerminationDate > CAST(GETUTCDATE() AS DATE))
            AND e2.ProductId NOT IN (SELECT DISTINCT BundleProductId FROM oe.ProductBundles WHERE BundleProductId IS NOT NULL)
        ) AS ProductCount,
        STUFF((
          SELECT ', ' + n.Name
          FROM (
            SELECT DISTINCT pr2.ProductId, pr2.Name
            FROM oe.Enrollments e2
            INNER JOIN oe.Products pr2 ON e2.ProductId = pr2.ProductId
            WHERE (
              (p.HouseholdId IS NOT NULL AND e2.HouseholdId = p.HouseholdId)
              OR (p.GroupId IS NOT NULL AND EXISTS (SELECT 1 FROM oe.Members m WHERE m.MemberId = e2.MemberId AND m.GroupId = p.GroupId))
            )
              AND e2.ProductId IS NOT NULL
              AND e2.ProductId != '00000000-0000-0000-0000-000000000000'
              AND e2.CreatedDate <= p.PaymentDate
              AND (e2.TerminationDate IS NULL OR e2.TerminationDate > p.PaymentDate)
              AND (e2.TerminationDate IS NULL OR e2.TerminationDate > CAST(GETUTCDATE() AS DATE))
              AND e2.ProductId NOT IN (SELECT DISTINCT BundleProductId FROM oe.ProductBundles WHERE BundleProductId IS NOT NULL)
          ) n
          ORDER BY n.Name
          FOR XML PATH(''), TYPE
        ).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS ProductNames
      FROM oe.Payments p
      INNER JOIN oe.Agents a ON p.AgentId = a.AgentId
      INNER JOIN oe.Users u ON a.UserId = u.UserId
      LEFT JOIN oe.Groups pg ON p.GroupId = pg.GroupId
      LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
      WHERE p.Status IN ('Completed', 'Draft', 'APPROVAL', 'SUCCESS', 'COMPLETED', 'succeeded')
        AND p.AgentId IS NOT NULL
        AND COALESCE(inv.Commission, p.Commission) IS NOT NULL
        AND COALESCE(inv.Commission, p.Commission) > 0
        AND a.Status = 'Active'
        AND NOT EXISTS (
          SELECT 1
          FROM oe.Commissions c
          WHERE c.Status != 'Deleted'
            AND (
              c.PaymentId = p.PaymentId
              OR (p.InvoiceId IS NOT NULL AND c.InvoiceId = p.InvoiceId)
              OR EXISTS (
                SELECT 1 FROM oe.Payments pLink
                WHERE pLink.InvoiceId = p.InvoiceId
                  AND pLink.PaymentId = c.PaymentId
              )
            )
        )
        ${tenantFilterClause}
        ${dateFilterClause}
      ORDER BY p.PaymentDate ASC
    `);

    const items = (result.recordset || []).map((row) => {
      const productNamesStr = row.ProductNames || '';
      const productNames = productNamesStr ? productNamesStr.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const isGroup = row.GroupId != null;
      return {
        paymentId: row.PaymentId,
        invoiceId: row.InvoiceId ? row.InvoiceId.toString() : null,
        invoiceNumber: row.InvoiceNumber || null,
        invoiceStatus: row.InvoiceStatus || null,
        invoicePaymentReceivedDate: row.InvoicePaymentReceivedDate || null,
        paymentDate: row.PaymentDate,
        amount: row.Amount,
        commission: row.Commission,
        paymentStatus: row.PaymentStatus,
        agentName: row.AgentName || 'Unknown',
        agentCommissionTierLevel: row.AgentCommissionTierLevel != null ? row.AgentCommissionTierLevel : null,
        agentId: row.AgentId ? row.AgentId.toString() : null,
        clientName: row.ClientName || '—',
        clientType: isGroup ? 'group' : 'individual',
        groupId: isGroup ? row.GroupId : null,
        memberId: !isGroup && row.PrimaryMemberId != null ? row.PrimaryMemberId : null,
        productCount: row.ProductCount != null ? row.ProductCount : 0,
        productNames,
        sellingAgentExpectedAmount: null,
        uplineExpectedAmounts: [],
        uplineExpectedTotal: 0,
        sellingAgentZeroPayout: false,
        zeroPayoutReason: null
      };
    });

    // Enrich preview rows with payout-chain summaries (selling agent + uplines)
    // using the same distribution path as dry-run generation.
    const batchSize = 6;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const summaries = await Promise.all(batch.map(async (item) => {
        try {
          const summary = await CommissionServiceAdvances.getPaymentPayoutChainSummary(item.paymentId);
          return { paymentId: item.paymentId, summary };
        } catch (summaryErr) {
          logger.warn('Unable to compute payout-chain summary for missing-preview row', {
            paymentId: item.paymentId,
            error: summaryErr.message
          }, 'Commission');
          return { paymentId: item.paymentId, summary: null };
        }
      }));
      const byPaymentId = new Map(summaries.map((s) => [s.paymentId, s.summary]));
      for (const item of batch) {
        const summary = byPaymentId.get(item.paymentId);
        if (!summary) continue;
        item.sellingAgentExpectedAmount = summary.sellingAgentExpectedAmount;
        item.uplineExpectedAmounts = summary.uplineExpectedAmounts || [];
        item.uplineExpectedTotal = summary.uplineExpectedTotal || 0;
        item.agencyExpectedTotal = summary.agencyExpectedTotal || 0;
        item.sellingAgentZeroPayout = summary.sellingAgentZeroPayout === true;
        item.zeroPayoutReason = summary.zeroPayoutReason || null;
      }
    }

    res.json({
      success: true,
      items,
      count: items.length,
      message: items.length === 0 ? 'No invoices need commission generation' : `${items.length} invoice(s) would get commissions`
    });
  } catch (error) {
    logger.error('Error fetching missing commissions preview', { error: error.message, user: req.user?.UserId }, 'Commission');
    res.status(500).json({
      success: false,
      message: 'Failed to load preview'
    });
  }
});

/**
 * Map a skipped-invoice row to API skip reason codes (invoice + enrollment agent).
 */
function mapSkippedInvoiceReason(row) {
  if (!row.ResolvedAgentId) {
    return { skipReason: 'NO_AGENT_ON_ENROLLMENT', skipReasonLabel: 'No agent on enrollment' };
  }
  if (!row.AgentRecordId) {
    return { skipReason: 'AGENT_NOT_FOUND', skipReasonLabel: 'Agent record not found' };
  }
  if (row.AgentTenantId && row.AgentTenantId !== row.InvoiceTenantId) {
    return { skipReason: 'AGENT_DIFFERENT_TENANT', skipReasonLabel: 'Agent is in a different tenant' };
  }
  if ((row.AgentStatus || '').toLowerCase() !== 'active') {
    return {
      skipReason: 'AGENT_NOT_ACTIVE',
      skipReasonLabel: `Agent not active (${row.AgentStatus || 'Unknown'})`
    };
  }
  if (row.Commission == null) {
    return { skipReason: 'NO_COMMISSION_ON_INVOICE', skipReasonLabel: 'Commission not on invoice' };
  }
  if (Number(row.Commission) <= 0) {
    return { skipReason: 'ZERO_COMMISSION', skipReasonLabel: 'Commission amount is $0' };
  }
  return { skipReason: 'UNKNOWN', skipReasonLabel: 'Skipped (unknown reason)' };
}

/**
 * @route GET /api/commissions/skipped-invoices
 * @desc Paid invoices in range with no commission rows that will not be auto-generated
 *       (no enrollment agent, inactive/cross-tenant agent, or zero/null invoice commission).
 *       Invoice-anchored — excludes refund payment ledger rows.
 * @access SysAdmin, TenantAdmin (tenant-scoped)
 */
router.get('/skipped-invoices', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const reqObj = pool.request();
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'TenantId required' });
    }
    reqObj.input('TenantId', sql.UniqueIdentifier, tenantId);

    const { startDate, endDate } = req.query;
    let dateFilterClause = '';
    if (startDate && endDate) {
      reqObj.input('StartDate', sql.Date, startDate);
      reqObj.input('EndDate', sql.Date, endDate);
      dateFilterClause = `
        AND CAST(COALESCE(inv.PaymentReceivedDate, inv.DueDate) AS DATE) >= @StartDate
        AND CAST(COALESCE(inv.PaymentReceivedDate, inv.DueDate) AS DATE) <= @EndDate`;
    }

    const result = await reqObj.query(`
      SELECT
        inv.InvoiceId,
        inv.InvoiceNumber,
        inv.Status AS InvoiceStatus,
        inv.TotalAmount,
        inv.Commission,
        inv.TenantId AS InvoiceTenantId,
        COALESCE(inv.PaymentReceivedDate, inv.DueDate) AS AnchorDate,
        inv.DueDate,
        inv.PaymentReceivedDate,
        inv.HouseholdId,
        inv.GroupId,
        e.AgentId AS ResolvedAgentId,
        a.AgentId AS AgentRecordId,
        a.Status AS AgentStatus,
        a.TenantId AS AgentTenantId,
        ISNULL(u.FirstName + ' ' + u.LastName, '') AS AgentName,
        CASE
          WHEN inv.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN pg.Name
          ELSE (
            SELECT TOP 1 um.FirstName + ' ' + um.LastName
            FROM oe.Members mm
            INNER JOIN oe.Users um ON mm.UserId = um.UserId
            WHERE mm.HouseholdId = inv.HouseholdId
            ORDER BY CASE WHEN mm.RelationshipType = 'P' THEN 0 ELSE 1 END
          )
        END AS ClientName,
        (SELECT TOP 1 mm.MemberId
           FROM oe.Members mm
           INNER JOIN oe.Users um ON mm.UserId = um.UserId
           WHERE mm.HouseholdId = inv.HouseholdId
           ORDER BY CASE WHEN mm.RelationshipType = 'P' THEN 0 ELSE 1 END
        ) AS PrimaryMemberId
      FROM oe.Invoices inv
      LEFT JOIN oe.Groups pg ON inv.GroupId = pg.GroupId
      OUTER APPLY (
        SELECT TOP 1 e.AgentId
        FROM oe.Enrollments e
        LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE e.Status = 'Active'
          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND (
            (inv.HouseholdId IS NOT NULL AND e.HouseholdId = inv.HouseholdId AND m.RelationshipType = 'P')
            OR (inv.GroupId IS NOT NULL AND m.GroupId = inv.GroupId AND m.RelationshipType = 'P')
          )
          AND (e.EffectiveDate IS NULL OR e.EffectiveDate <= inv.BillingPeriodEnd)
          AND (e.TerminationDate IS NULL OR e.TerminationDate > inv.BillingPeriodStart)
        ORDER BY e.CreatedDate ASC
      ) e
      LEFT JOIN oe.Agents a ON e.AgentId = a.AgentId
      LEFT JOIN oe.Users u ON a.UserId = u.UserId
      WHERE inv.TenantId = @TenantId
        AND inv.Status = N'Paid'
        -- Treat payment-anchored rows on linked payments as satisfying the invoice
        -- (legacy rows often have c.InvoiceId NULL until backfilled).
        AND NOT EXISTS (
          SELECT 1 FROM oe.Commissions c
          WHERE c.Status != N'Deleted'
            AND (
              c.InvoiceId = inv.InvoiceId
              OR EXISTS (
                SELECT 1 FROM oe.Payments p
                WHERE p.InvoiceId = inv.InvoiceId
                  AND p.PaymentId = c.PaymentId
              )
            )
        )
        -- No commission pool and no dollars: not actionable (e.g. $0 placeholder invoices).
        AND NOT (
          ISNULL(inv.TotalAmount, 0) = 0
          AND ISNULL(inv.Commission, 0) = 0
        )
        AND (
          e.AgentId IS NULL
          OR a.AgentId IS NULL
          OR a.Status <> 'Active'
          OR a.TenantId <> inv.TenantId
          OR inv.Commission IS NULL
          OR inv.Commission <= 0
        )
        ${dateFilterClause}
      ORDER BY COALESCE(inv.PaymentReceivedDate, inv.DueDate) DESC
    `);

    const items = (result.recordset || []).map((row) => {
      const { skipReason, skipReasonLabel } = mapSkippedInvoiceReason(row);
      const isGroup = row.GroupId != null;
      return {
        invoiceId: row.InvoiceId.toString(),
        invoiceNumber: row.InvoiceNumber || null,
        anchorDate: row.AnchorDate,
        dueDate: row.DueDate,
        paymentReceivedDate: row.PaymentReceivedDate,
        totalAmount: Number(row.TotalAmount) || 0,
        commission: row.Commission != null ? Number(row.Commission) : null,
        invoiceStatus: row.InvoiceStatus,
        agentId: row.ResolvedAgentId ? row.ResolvedAgentId.toString() : null,
        agentName: row.AgentName || null,
        agentStatus: row.AgentStatus || null,
        agentTenantId: row.AgentTenantId ? row.AgentTenantId.toString() : null,
        invoiceTenantId: row.InvoiceTenantId ? row.InvoiceTenantId.toString() : null,
        clientName: row.ClientName || '—',
        clientType: isGroup ? 'group' : 'individual',
        groupId: isGroup ? row.GroupId : null,
        memberId: !isGroup && row.PrimaryMemberId != null ? row.PrimaryMemberId : null,
        skipReason,
        skipReasonLabel
      };
    });

    res.json({
      success: true,
      items,
      count: items.length,
      message:
        items.length === 0
          ? 'No skipped invoices in this range'
          : `${items.length} paid invoice(s) in range will not generate commissions automatically`
    });
  } catch (error) {
    logger.error('Error fetching skipped invoices', { error: error.message, user: req.user?.UserId }, 'Commission');
    res.status(500).json({
      success: false,
      message: 'Failed to load skipped invoices'
    });
  }
});

/**
 * @route GET /api/commissions/skipped-payments
 * @desc @deprecated Use skipped-invoices. Payment-level list (includes refund ledger rows).
 * @access SysAdmin, TenantAdmin (tenant-scoped by the calling tenant)
 */
router.get('/skipped-payments', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const reqObj = pool.request();
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'TenantId required' });
    }
    reqObj.input('TenantId', sql.UniqueIdentifier, tenantId);

    const { startDate, endDate } = req.query;
    let dateFilterClause = '';
    if (startDate && endDate) {
      reqObj.input('StartDate', sql.Date, startDate);
      reqObj.input('EndDate', sql.Date, endDate);
      dateFilterClause =
        ' AND CAST(p.PaymentDate AS DATE) >= @StartDate AND CAST(p.PaymentDate AS DATE) <= @EndDate';
    }

    const result = await reqObj.query(`
      SELECT
        p.PaymentId,
        p.AgentId,
        p.PaymentDate,
        p.Amount,
        -- Invoice-sourced payouts: prefer invoice breakdowns with payment fallback
        COALESCE(inv.Commission, p.Commission) AS Commission,
        p.Status AS PaymentStatus,
        p.TenantId AS PaymentTenantId,
        a.AgentId AS AgentRecordId,
        a.Status AS AgentStatus,
        a.TenantId AS AgentTenantId,
        ISNULL(u.FirstName + ' ' + u.LastName, '') AS AgentName,
        CASE
          WHEN p.GroupId IS NOT NULL AND pg.Name IS NOT NULL THEN pg.Name
          ELSE (
            SELECT TOP 1 um.FirstName + ' ' + um.LastName
            FROM oe.Members mm
            INNER JOIN oe.Users um ON mm.UserId = um.UserId
            WHERE mm.HouseholdId = p.HouseholdId
            ORDER BY CASE WHEN mm.RelationshipType = 'P' THEN 0 ELSE 1 END
          )
        END AS ClientName,
        p.GroupId AS GroupId,
        (SELECT TOP 1 mm.MemberId
           FROM oe.Members mm
           INNER JOIN oe.Users um ON mm.UserId = um.UserId
           WHERE mm.HouseholdId = p.HouseholdId
           ORDER BY CASE WHEN mm.RelationshipType = 'P' THEN 0 ELSE 1 END
        ) AS PrimaryMemberId
      FROM oe.Payments p
      LEFT JOIN oe.Agents a ON p.AgentId = a.AgentId
      LEFT JOIN oe.Users u ON a.UserId = u.UserId
      LEFT JOIN oe.Groups pg ON p.GroupId = pg.GroupId
      LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
      WHERE p.TenantId = @TenantId
        AND p.Status IN ('Completed', 'Draft', 'APPROVAL', 'SUCCESS', 'COMPLETED', 'succeeded')
        AND NOT EXISTS (
          SELECT 1 FROM oe.Commissions c
          WHERE c.PaymentId = p.PaymentId AND c.Status != 'Deleted'
        )
        AND (
          p.AgentId IS NULL
          OR a.AgentId IS NULL
          OR a.Status <> 'Active'
          OR a.TenantId <> p.TenantId
          OR COALESCE(inv.Commission, p.Commission) IS NULL
          OR COALESCE(inv.Commission, p.Commission) <= 0
        )
        ${dateFilterClause}
      ORDER BY p.PaymentDate DESC
    `);

    const items = (result.recordset || []).map((row) => {
      let skipReason;
      let skipReasonLabel;
      if (!row.AgentId) {
        skipReason = 'NO_AGENT_ON_PAYMENT';
        skipReasonLabel = 'No agent on payment';
      } else if (!row.AgentRecordId) {
        skipReason = 'AGENT_NOT_FOUND';
        skipReasonLabel = 'Agent record not found';
      } else if (row.AgentTenantId && row.AgentTenantId !== row.PaymentTenantId) {
        skipReason = 'AGENT_DIFFERENT_TENANT';
        skipReasonLabel = 'Agent is in a different tenant';
      } else if ((row.AgentStatus || '').toLowerCase() !== 'active') {
        skipReason = 'AGENT_NOT_ACTIVE';
        skipReasonLabel = `Agent not active (${row.AgentStatus || 'Unknown'})`;
      } else if (row.Commission == null) {
        skipReason = 'NO_COMMISSION_COMPUTED';
        skipReasonLabel = 'Commission not computed on payment';
      } else if (Number(row.Commission) <= 0) {
        skipReason = 'ZERO_COMMISSION';
        skipReasonLabel = 'Commission amount is $0';
      } else {
        skipReason = 'UNKNOWN';
        skipReasonLabel = 'Skipped (unknown reason)';
      }
      const isGroup = row.GroupId != null;
      return {
        paymentId: row.PaymentId,
        paymentDate: row.PaymentDate,
        amount: Number(row.Amount) || 0,
        commission: row.Commission != null ? Number(row.Commission) : null,
        paymentStatus: row.PaymentStatus,
        agentId: row.AgentId ? row.AgentId.toString() : null,
        agentName: row.AgentName || null,
        agentStatus: row.AgentStatus || null,
        agentTenantId: row.AgentTenantId ? row.AgentTenantId.toString() : null,
        paymentTenantId: row.PaymentTenantId ? row.PaymentTenantId.toString() : null,
        clientName: row.ClientName || '—',
        clientType: isGroup ? 'group' : 'individual',
        groupId: isGroup ? row.GroupId : null,
        memberId: !isGroup && row.PrimaryMemberId != null ? row.PrimaryMemberId : null,
        skipReason,
        skipReasonLabel
      };
    });

    res.json({
      success: true,
      items,
      count: items.length,
      message:
        items.length === 0
          ? 'No skipped payments in this range'
          : `${items.length} payment(s) in range will not generate commissions automatically`
    });
  } catch (error) {
    logger.error('Error fetching skipped payments', { error: error.message, user: req.user?.UserId }, 'Commission');
    res.status(500).json({
      success: false,
      message: 'Failed to load skipped payments'
    });
  }
});

/**
 * @route GET /api/commissions/missing-preview/:paymentId/breakdown
 * @desc Get per-product commission breakdown for a payment (who gets paid what)
 * @access SysAdmin, TenantAdmin (tenant-scoped)
 */
router.get('/missing-preview/:paymentId/breakdown', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { paymentId } = req.params;
    const userRoles = getUserRoles(req.user);
    const isTenantAdmin = userRoles.includes('TenantAdmin');
    if (isTenantAdmin) {
      const tenantId = req.tenantId || req.user?.TenantId;
      if (tenantId) {
        const pool = await getPool();
        const checkResult = await pool.request()
          .input('PaymentId', sql.UniqueIdentifier, paymentId)
          .input('TenantId', sql.UniqueIdentifier, tenantId)
          .query(`
            SELECT 1 FROM oe.Payments p
            INNER JOIN oe.Agents a ON p.AgentId = a.AgentId
            WHERE p.PaymentId = @PaymentId AND a.TenantId = @TenantId
          `);
        if (!checkResult.recordset?.length) {
          return res.status(403).json({ success: false, message: 'Payment not found or access denied' });
        }
      }
    }
    const result = await CommissionServiceAdvances.getPaymentBreakdownPreview(paymentId);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Payment not found or already has commissions' });
    }
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Error fetching payment breakdown', {
      error: error.message,
      stack: error.stack,
      paymentId: req.params.paymentId
    }, 'Commission');
    res.status(500).json({
      success: false,
      message: 'Failed to load payment breakdown'
    });
  }
});

/**
 * @route GET /api/commissions/hierarchy/:agentId
 * @desc Get agent commission hierarchy
 * @access Agent (own), Agency, TenantAdmin, SysAdmin
 */
router.get('/hierarchy/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;
    
    // Check authorization - agents can only see their own hierarchy
    if (getUserRoles(req.user).includes('Agent') && req.user.AgentId !== agentId) {
      return res.status(403).json({ 
        success: false, 
        message: 'Unauthorized to view this hierarchy' 
      });
    }
    
    const hierarchy = await commissionService.getCommissionHierarchy(agentId);
    
    res.json({
      success: true,
      hierarchy
    });
    
  } catch (error) {
    logger.error('Error fetching commission hierarchy', { error: error.message, agentId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch commission hierarchy' 
    });
  }
});

/**
 * @route GET /api/commissions/summary
 * @desc Get commission summary for user's scope
 * @access Agent (own), Agency, TenantAdmin, SysAdmin
 */
router.get('/summary', async (req, res) => {
  try {
    const { entityType, entityId, period } = req.query;
    
    let queryEntityType = entityType || 'Agent';
    let queryEntityId = entityId || req.user.AgentId;
    
    // Check authorization
    if (getUserRoles(req.user).includes('Agent') && 
        (queryEntityType !== 'Agent' || queryEntityId !== req.user.AgentId)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Unauthorized to view these commissions' 
      });
    }
    
    const summary = await commissionService.getCommissionSummary(
      queryEntityType,
      queryEntityId,
      period
    );
    
    res.json({
      success: true,
      ...summary
    });
    
  } catch (error) {
    logger.error('Error fetching commission summary', { error: error.message, entityType, entityId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch commission summary' 
    });
  }
});

/**
 * @route GET /api/commissions/statement
 * @desc Get commission statement
 * @access Agent (own), Agency, TenantAdmin, SysAdmin
 */
router.get('/statement', async (req, res) => {
  try {
    const { entityType, entityId, startDate, endDate } = req.query;
    
    let queryEntityType = entityType || 'Agent';
    let queryEntityId = entityId || req.user.AgentId;
    
    // Check authorization
    if (getUserRoles(req.user).includes('Agent') && 
        (queryEntityType !== 'Agent' || queryEntityId !== req.user.AgentId)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Unauthorized to view this statement' 
      });
    }
    
    const statement = await commissionService.getCommissionStatement(
      queryEntityType,
      queryEntityId,
      startDate,
      endDate
    );
    
    res.json({
      success: true,
      statement
    });
    
  } catch (error) {
    logger.error('Error fetching commission statement', { error: error.message, entityType, entityId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch commission statement' 
    });
  }
});

/**
 * @route GET /api/commissions/upcoming
 * @desc Get upcoming commission payments
 * @access Agent (own), Agency, TenantAdmin, SysAdmin
 */
router.get('/upcoming', async (req, res) => {
  try {
    const { entityType, entityId } = req.query;
    
    let queryEntityType = entityType || 'Agent';
    let queryEntityId = entityId || req.user.AgentId;
    
    // Check authorization
    if (getUserRoles(req.user).includes('Agent') && 
        (queryEntityType !== 'Agent' || queryEntityId !== req.user.AgentId)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Unauthorized to view these payments' 
      });
    }
    
    const upcoming = await commissionService.getUpcomingPayments(
      queryEntityType,
      queryEntityId
    );
    
    res.json({
      success: true,
      ...upcoming
    });
    
  } catch (error) {
    logger.error('Error fetching upcoming payments', { error: error.message, user: req.user.UserId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch upcoming payments' 
    });
  }
});

/**
 * @route POST /api/commissions/simulate
 * @desc Simulate commission calculation
 * @access Agent, TenantAdmin, SysAdmin
 */
router.post('/simulate', async (req, res) => {
  try {
    const { productId, premiumAmount, agentId } = req.body;
    
    if (!productId || !premiumAmount || !agentId) {
      return res.status(400).json({
        success: false,
        message: 'productId, premiumAmount, and agentId are required'
      });
    }
    
    const simulation = await commissionService.simulateCommission({
      productId,
      premiumAmount,
      agentId
    });
    
    res.json({
      success: true,
      simulation
    });
    
  } catch (error) {
    logger.error('Error simulating commission', { error: error.message, productId, agentId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to simulate commission' 
    });
  }
});

/**
 * @route POST /api/commissions/simulate-detailed
 * @desc Simulate commission calculation with detailed step-by-step breakdown
 * @access Agent, TenantAdmin, SysAdmin, AgencyOwner
 */
router.post('/simulate-detailed', authorize(['Agent', 'TenantAdmin', 'SysAdmin', 'AgencyOwner']), async (req, res) => {
  try {
    console.log('[simulate-detailed] Request body:', JSON.stringify(req.body));
    const { 
      tenantId, // SysAdmin only - required for SysAdmin
      agentId, // Required - agent to simulate commission for
      commissionRuleId, // Optional - for TenantAdmin/SysAdmin to select a rule
      allocatedCommissionAmount, // Required - the commission amount to simulate
      vendorCommissionAmount, // Optional - NetRate (100% goes to vendor) for simulation
      overrideAmount, // Optional - OverrideRate (paid 100% to override destinations) for simulation
      productPricingId, // Optional - ProductPricingId (for matching oe.ProductOverrides)
      productId, // Optional - for filtering rules
      paymentDate, // Optional - defaults to today
      productTier, // Optional - Product tier code (EE, ES, EC, EF) for tier-specific commission amounts
      groupId, // Optional - Group ID for testing split commission rules for groups
      allowUnlockedRules // Optional - include unlocked rules in simulation
    } = req.body;

    const userRoles = getUserRoles(req.user);
    let finalAgentId = agentId;
    let finalTenantId = req.user.TenantId;

    // Validate agentId is provided
    if (!agentId) {
      return res.status(400).json({
        success: false,
        message: 'agentId is required for commission simulation'
      });
    }

    // Role-based logic
    if (userRoles.includes('Agent') && req.user.AgentId) {
      // Agent: allow self, plus uplines (any depth) and agency admins of the
      // target agent's agency. Plain agent fall-through still self-only.
      const viewerAgentId = req.user.AgentId;
      finalTenantId = req.user.TenantId;

      if (agentId === viewerAgentId) {
        finalAgentId = viewerAgentId;
      } else {
        const accessPool = await getPool();
        const tgt = await accessPool.request()
          .input('AgentId', sql.UniqueIdentifier, agentId)
          .input('TenantId', sql.UniqueIdentifier, finalTenantId)
          .query(`SELECT AgentId, AgencyId FROM oe.Agents
                  WHERE AgentId = @AgentId AND TenantId = @TenantId AND Status = 'Active'`);
        if (tgt.recordset.length === 0) {
          return res.status(403).json({
            success: false,
            message: 'Not authorized to run scenarios for this agent'
          });
        }
        const targetAgencyId = tgt.recordset[0].AgencyId || null;

        const viewerRow = await accessPool.request()
          .input('AgentId', sql.UniqueIdentifier, viewerAgentId)
          .query(`SELECT AgencyId FROM oe.Agents WHERE AgentId = @AgentId`);
        const viewerAgencyId = viewerRow.recordset[0]?.AgencyId || null;

        const isUpline = await isUplineAncestor(accessPool, agentId, viewerAgentId);
        let isAgencyAdminOfTarget = false;
        if (targetAgencyId) {
          const sameAgencyOwnerJwt = userRoles.includes('AgencyOwner') &&
            viewerAgencyId &&
            targetAgencyId.toString().toLowerCase() === viewerAgencyId.toString().toLowerCase();
          isAgencyAdminOfTarget = sameAgencyOwnerJwt ||
            (await agencyAdmins.isAgencyAdmin(accessPool, targetAgencyId, viewerAgentId));
        }
        if (!isUpline && !isAgencyAdminOfTarget) {
          return res.status(403).json({
            success: false,
            message: 'Not authorized to run scenarios for this agent'
          });
        }
        finalAgentId = agentId;
      }

      // Defence-in-depth: agent-role callers may not reference rules / groups
      // belonging to another tenant. (Tighter scoping is enforced server-side
      // by the calculator service for the actual rule-resolution.)
      if (commissionRuleId) {
        const rulePool = await getPool();
        const ruleRes = await rulePool.request()
          .input('RuleId', sql.UniqueIdentifier, commissionRuleId)
          .query(`SELECT TenantId FROM oe.CommissionRules
                  WHERE RuleId = @RuleId AND Status <> 'Deleted'`);
        const ruleTenantId = ruleRes.recordset[0]?.TenantId || null;
        if (
          ruleTenantId &&
          ruleTenantId.toString().toLowerCase() !== finalTenantId.toString().toLowerCase()
        ) {
          return res.status(403).json({
            success: false,
            message: 'Not authorized to use this commission rule'
          });
        }
      }
      if (groupId) {
        const groupPool = await getPool();
        const groupRes = await groupPool.request()
          .input('GroupId', sql.UniqueIdentifier, groupId)
          .input('TenantId', sql.UniqueIdentifier, finalTenantId)
          .query(`SELECT GroupId FROM oe.Groups
                  WHERE GroupId = @GroupId AND TenantId = @TenantId`);
        if (groupRes.recordset.length === 0) {
          return res.status(403).json({
            success: false,
            message: 'Not authorized to use this group'
          });
        }
      }
    } else if (userRoles.includes('SysAdmin')) {
      // SysAdmin: Must select tenant first
      if (!tenantId) {
        return res.status(400).json({
          success: false,
          message: 'tenantId is required for SysAdmin'
        });
      }
      finalTenantId = tenantId;

      // Verify agentId belongs to the selected tenant
      if (finalAgentId) {
        const pool = await getPool();
        const agentRequest = pool.request();
        agentRequest.input('AgentId', sql.UniqueIdentifier, finalAgentId);
        agentRequest.input('TenantId', sql.UniqueIdentifier, finalTenantId);
        const agentResult = await agentRequest.query(`
          SELECT AgentId
          FROM oe.Agents
          WHERE AgentId = @AgentId
            AND TenantId = @TenantId
            AND Status = 'Active'
        `);
        
        if (agentResult.recordset.length === 0) {
          return res.status(400).json({
            success: false,
            message: 'Agent not found in selected tenant'
          });
        }
      }
    } else if (userRoles.includes('TenantAdmin')) {
      // TenantAdmin: Verify agentId belongs to their tenant
      if (finalAgentId) {
        const pool = await getPool();
        const agentRequest = pool.request();
        agentRequest.input('AgentId', sql.UniqueIdentifier, finalAgentId);
        agentRequest.input('TenantId', sql.UniqueIdentifier, finalTenantId);
        const agentResult = await agentRequest.query(`
          SELECT AgentId
          FROM oe.Agents
          WHERE AgentId = @AgentId
            AND TenantId = @TenantId
            AND Status = 'Active'
        `);
        
        if (agentResult.recordset.length === 0) {
          return res.status(400).json({
            success: false,
            message: 'Agent not found in your tenant'
          });
        }
      }
    }

    // Validate required fields
    if (!finalAgentId) {
      return res.status(400).json({
        success: false,
        message: 'agentId is required'
      });
    }

    // NOTE: allocatedCommissionAmount can legitimately be 0 (e.g., products with 0 vendor commission).
    // We still require it to be present and numeric.
    if (allocatedCommissionAmount === undefined || allocatedCommissionAmount === null || Number.isNaN(Number(allocatedCommissionAmount)) || Number(allocatedCommissionAmount) < 0) {
      return res.status(400).json({
        success: false,
        message: 'allocatedCommissionAmount is required and must be a number >= 0'
      });
    }

    // vendorCommissionAmount represents NetRate (vendor payout). It can be 0.
    if (vendorCommissionAmount !== undefined && vendorCommissionAmount !== null) {
      if (Number.isNaN(Number(vendorCommissionAmount)) || Number(vendorCommissionAmount) < 0) {
        return res.status(400).json({
          success: false,
          message: 'vendorCommissionAmount must be a number >= 0'
        });
      }
    }

    // overrideAmount represents OverrideRate (override payout). It can be 0.
    if (overrideAmount !== undefined && overrideAmount !== null) {
      if (Number.isNaN(Number(overrideAmount)) || Number(overrideAmount) < 0) {
        return res.status(400).json({
          success: false,
          message: 'overrideAmount must be a number >= 0'
        });
      }
    }

    if (!finalTenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenantId is required'
      });
    }

    // Use paymentDate or default to today
    const effectivePaymentDate = paymentDate ? new Date(paymentDate) : new Date();

    // Get agent's actual CommissionRuleId for reference
    const pool = await getPool();
    const agentRequest = pool.request();
    agentRequest.input('AgentId', sql.UniqueIdentifier, finalAgentId);
    const agentResult = await agentRequest.query(`
      SELECT CommissionRuleId
      FROM oe.Agents
      WHERE AgentId = @AgentId
    `);
    const agentActualRuleId = agentResult.recordset.length > 0 
      ? agentResult.recordset[0].CommissionRuleId?.toString() 
      : null;

    // For simulation without a product, we need to use a valid productId
    // Use the "All Products" GUID to allow all-product rules to apply
    // If a specific product is provided, use that instead
    let simulationProductId = productId;
    if (!simulationProductId) {
      // Use all-products GUID - this allows rules that apply to all products
      simulationProductId = '00000000-0000-0000-0000-000000000000';
      
      // Check if this product exists, if not, get any active product as fallback
      const productCheck = pool.request();
      productCheck.input('ProductId', sql.UniqueIdentifier, simulationProductId);
      const productExists = await productCheck.query(`
        SELECT TOP 1 ProductId
        FROM oe.Products
        WHERE ProductId = @ProductId AND Status = 'Active'
      `);
      
      if (productExists.recordset.length === 0) {
        // Get any active product from the tenant as fallback
        const fallbackProduct = pool.request();
        fallbackProduct.input('TenantId', sql.UniqueIdentifier, finalTenantId);
        const fallbackResult = await fallbackProduct.query(`
          SELECT TOP 1 ProductId
          FROM oe.Products
          WHERE TenantId = @TenantId AND Status = 'Active'
          ORDER BY CreatedDate DESC
        `);
        
        if (fallbackResult.recordset.length > 0) {
          simulationProductId = fallbackResult.recordset[0].ProductId.toString();
        } else {
          return res.status(400).json({
            success: false,
            message: 'No active products found. Please select a product or ensure tenant has active products.'
          });
        }
      }
    }

    // Use selected commissionRuleId as override for agent's assigned rule (for simulation)
    // If commissionRuleId is provided, use it; otherwise use agent's actual assigned rule from DB
    let overrideAgentRuleId = null;
    if (commissionRuleId) {
      overrideAgentRuleId = commissionRuleId;
    }

    // Call existing CommissionCalculatorService
    // For simulation: paymentId = null, paymentAmount = 0 (we use commissionAmount instead)
    // allowUnlockedRules: controlled by request (default false) to match UI checkbox
    const result = await commissionCalculatorService.calculateCommissions(
      null, // paymentId - null for simulation
      simulationProductId, // productId - required for calculation
      0, // paymentAmount - we use allocatedCommissionAmount instead
      finalAgentId, // agentId
      finalTenantId, // tenantId
      null, // enrollmentId
      Number(overrideAmount || 0), // overrideAmount - from pricing (OverrideRate)
      allocatedCommissionAmount, // commissionAmount - this is our input
      Number(vendorCommissionAmount || 0), // vendorCommissionAmount - from pricing (NetRate)
      null, // householdId
      groupId || null, // groupId - optional, for testing split commission rules for groups
      effectivePaymentDate, // paymentDate
      Boolean(allowUnlockedRules), // allowUnlockedRules
      overrideAgentRuleId, // overrideAgentRuleId - use selected rule for simulation
      productTier, // productTier - Product tier code (EE, ES, EC, EF) for tier-specific amounts
      null, // enrollmentProductIds
      null, // productCommissionAmounts
      null, // productEnrollmentCounts
      false, // useCurrentDateForRuleEffectiveness
      null, // productVendorAmounts
      productId && productPricingId
        ? new Map([[productId, { productPricingId }]])
        : null // productOwnerAmounts (use ProductOverrides for override payout destinations)
    );

    // Simulate agent-to-agent commission overrides against the computed distribution
    // so the simulator shows the same net amounts that would post after generation.
    const agentOverridesPreview = [];
    try {
      const distribution = result.distribution || { agents: [] };
      const agentTotals = new Map();
      for (const row of (distribution.agents || [])) {
        if (!row?.agentId) continue;
        const prev = agentTotals.get(row.agentId) || 0;
        agentTotals.set(row.agentId, prev + Number(row.amount || 0));
      }

      const sourceIds = Array.from(agentTotals.keys());
      if (sourceIds.length > 0) {
        const ovReq = pool.request();
        ovReq.input('TenantId', sql.UniqueIdentifier, finalTenantId);
        const placeholders = sourceIds.map((id, i) => {
          ovReq.input(`Src${i}`, sql.UniqueIdentifier, id);
          return `@Src${i}`;
        }).join(', ');
        ovReq.input('PaymentDate', sql.Date, effectivePaymentDate);

        let ovRows = [];
        try {
          const ovRes = await ovReq.query(`
            SELECT o.OverrideId, o.SourceAgentId, o.RecipientAgentId, o.OverrideType,
                   o.OverrideAmount, o.OverridePercentage,
                   (su.FirstName + ' ' + su.LastName) AS SourceAgentName,
                   (ru.FirstName + ' ' + ru.LastName) AS RecipientAgentName
            FROM oe.AgentCommissionOverrides o
            LEFT JOIN oe.Agents sa ON o.SourceAgentId = sa.AgentId
            LEFT JOIN oe.Users su ON sa.UserId = su.UserId
            LEFT JOIN oe.Agents ra ON o.RecipientAgentId = ra.AgentId
            LEFT JOIN oe.Users ru ON ra.UserId = ru.UserId
            WHERE o.TenantId = @TenantId
              AND o.Status = 'Active'
              AND o.SourceAgentId IN (${placeholders})
              AND (o.EffectiveDate IS NULL OR o.EffectiveDate <= @PaymentDate)
              AND (o.TerminationDate IS NULL OR o.TerminationDate >= @PaymentDate)
            ORDER BY o.CreatedDate ASC
          `);
          ovRows = ovRes.recordset || [];
        } catch (ovErr) {
          if (!(ovErr?.message && /Invalid object name|AgentCommissionOverrides/i.test(ovErr.message))) {
            throw ovErr;
          }
          ovRows = [];
        }

        for (const ov of ovRows) {
          const srcId = ov.SourceAgentId;
          const sourceTotal = agentTotals.get(srcId) || 0;
          let amount = 0;
          if (ov.OverrideType === 'Fixed') {
            amount = Number(ov.OverrideAmount || 0);
          } else if (ov.OverrideType === 'Percentage') {
            amount = Math.round((sourceTotal * Number(ov.OverridePercentage || 0) / 100) * 100) / 100;
          }
          const entry = {
            overrideId: ov.OverrideId,
            overrideType: ov.OverrideType,
            sourceAgentId: srcId,
            sourceAgentName: ov.SourceAgentName || 'Unknown',
            recipientAgentId: ov.RecipientAgentId,
            recipientAgentName: ov.RecipientAgentName || null,
            amount: amount > 0 ? amount : 0,
            sourceTotalBefore: sourceTotal
          };
          if (amount <= 0) {
            entry.skipped = true;
            entry.skipReason = 'Computed override amount is zero';
          } else if (amount > sourceTotal) {
            entry.skipped = true;
            entry.skipReason = `Source agent commission (${sourceTotal.toFixed(2)}) is less than override amount (${amount.toFixed(2)})`;
          } else {
            agentTotals.set(srcId, sourceTotal - amount);
          }
          agentOverridesPreview.push(entry);
        }
      }
    } catch (overridePreviewErr) {
      console.warn('[simulate-detailed] Could not simulate agent overrides:', overridePreviewErr.message);
    }

    // Map distribution to breakdown for frontend compatibility
    let simulationResult = {
      agentId: finalAgentId,
      tenantId: finalTenantId,
      productId: productId || null,
      allocatedCommissionAmount,
      paymentDate: effectivePaymentDate,
      commissionRuleId: commissionRuleId || null,
      agentActualRuleId: agentActualRuleId, // The agent's actual assigned rule from DB
      selectedRuleId: overrideAgentRuleId || null, // The rule selected for simulation
      breakdown: result.distribution || { agents: [], vendors: [], tenants: [] }, // Map distribution to breakdown
      agentOverrides: agentOverridesPreview, // Per-payment agent-to-agent overrides applied to this simulation
      totalCommissionsPaid: result.totalCommissionsPaid || 0,
      vendorCommissionPaid: result.vendorCommissionAmount || 0,
      totalPayouts: (result.totalCommissionsPaid || 0) + (result.vendorCommissionAmount || 0),
      remainingAmount: result.remainingAmount || 0,
      overflowToProductOwner: result.overflowToProductOwner || 0
    };

    // Agent / AgencyOwner viewers see a filtered breakdown — see
    // backend/utils/redactAgentCommissionSimulation.js. SysAdmin / TenantAdmin
    // keep the unredacted view (existing admin tooling depends on it).
    // AgencyOwner-only viewers MUST also be redacted: an agency admin who
    // is not admin of the tenant's primary agency should never see that
    // agency's overflow row (visible-set rule keys on adminAgencyIds).
    const isAdminViewer = userRoles.includes('SysAdmin') || userRoles.includes('TenantAdmin');
    const isAgentSideViewer = !isAdminViewer && (userRoles.includes('Agent') || userRoles.includes('AgencyOwner'));
    if (isAgentSideViewer && req.user.AgentId) {
      try {
        const redactPool = await getPool();
        const viewerAgentId = req.user.AgentId;
        const viewerUserId = req.user.UserId || req.user.userId || null;

        const viewerAgentRow = await redactPool.request()
          .input('AgentId', sql.UniqueIdentifier, viewerAgentId)
          .query(`SELECT AgencyId FROM oe.Agents WHERE AgentId = @AgentId`);
        const viewerAgencyId = viewerAgentRow.recordset[0]?.AgencyId || null;

        const selfAndDownlineAgentIds = viewerUserId
          ? await getSelfAndDownlineAgentIds(redactPool, viewerUserId)
          : [];

        // Agencies the viewer admins. JWT AgencyOwner alone is not enough —
        // a stale role claim must be backed by an active oe.AgencyAdmins row.
        const adminAgencyIds = [];
        const agencyAdminRecords = await agencyAdmins
          .getAdministeredAgenciesForAgent(redactPool, viewerAgentId);
        for (const row of agencyAdminRecords?.recordset || []) {
          if (row?.AgencyId) adminAgencyIds.push(row.AgencyId.toString());
        }

        let agencyAgentIds = [];
        for (const aid of adminAgencyIds) {
          const ids = await getAgentIdsForAgency(redactPool, aid);
          for (const x of ids) agencyAgentIds.push(x);
        }

        simulationResult = redactSimulationForAgent(simulationResult, {
          viewerAgentId,
          viewerAgencyId,
          selfAndDownlineAgentIds,
          agencyAgentIds,
          adminAgencyIds
        });
      } catch (redactErr) {
        logger.warn('Could not redact simulator response for agent viewer', {
          error: redactErr.message,
          paymentSim: true
        }, 'Commission');
        // Fail-closed: collapse to an empty breakdown so we don't leak.
        simulationResult.breakdown = { agents: [], vendors: simulationResult.breakdown?.vendors || [], tenants: [] };
        simulationResult.agentOverrides = [];
      }
    }

    res.json({
      success: true,
      simulation: simulationResult
    });

  } catch (error) {
    // Log to console so errors are visible in terminal (logger writes to DB only)
    console.error('[simulate-detailed] Error:', error.message, '\nStack:', error.stack, '\nBody:', JSON.stringify(req.body));
    logger.error('Error simulating commission', { 
      error: error.message, 
      stack: error.stack,
      body: req.body,
      user: req.user.UserId 
    }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to simulate commission',
      error: error.message
    });
  }
});

/**
 * @route POST /api/commissions/payout-destinations
 * @desc Resolve payout destinations (masked bank info) for simulation results, similar to NACHA recipient resolution.
 * @access Agent, TenantAdmin, SysAdmin, AgencyOwner
 */
router.post('/payout-destinations', authorize(['Agent', 'TenantAdmin', 'SysAdmin', 'AgencyOwner']), async (req, res) => {
  try {
    const { vendorIds = [], overrideRecipientIds = [], overrideAchIds = [] } = req.body || {};

    const uniqueVendorIds = Array.from(new Set((Array.isArray(vendorIds) ? vendorIds : []).filter(Boolean)));
    const uniqueOverrideIds = Array.from(new Set((Array.isArray(overrideRecipientIds) ? overrideRecipientIds : []).filter(Boolean)));
    const uniqueOverrideAchIds = Array.from(new Set((Array.isArray(overrideAchIds) ? overrideAchIds : []).filter(Boolean)));

    const pool = await getPool();

    const vendors = {};
    for (const vendorId of uniqueVendorIds) {
      try {
        const nameReq = pool.request();
        nameReq.input('VendorId', sql.UniqueIdentifier, vendorId);
        const vendorNameRes = await nameReq.query(`
          SELECT TOP 1 VendorName
          FROM oe.Vendors
          WHERE VendorId = @VendorId
        `);
        const vendorName = vendorNameRes.recordset[0]?.VendorName || null;

        // ACH destinations: all active Vendor ACH accounts (masked; no decrypted fields).
        const allAch = await achService.getAllACHAccounts('Vendor', vendorId, false);
        const achAccounts = (Array.isArray(allAch) ? allAch : [])
          .filter((a) => (a?.Status || '').toString().toLowerCase() === 'active')
          .map((a) => ({
            achAccountId: a.ACHAccountId || null,
            bankName: a.BankName || null,
            accountHolderName: a.AccountHolderName || null,
            accountType: a.AccountType || null,
            accountNumberLast4: a.AccountNumberLast4 || null,
            distributionPercentage:
              a.DistributionPercentage !== undefined && a.DistributionPercentage !== null
                ? Number(a.DistributionPercentage)
                : null,
            isDefault: a.IsDefault === true || a.IsDefault === 1,
            status: a.Status || null,
          }));

        vendors[vendorId] = {
          entityType: 'Vendor',
          entityId: vendorId,
          displayName: vendorName,
          achAccounts,
        };
      } catch (e) {
        vendors[vendorId] = {
          entityType: 'Vendor',
          entityId: vendorId,
          displayName: null,
          achAccounts: [],
          error: e instanceof Error ? e.message : 'Failed to resolve vendor destination',
        };
      }
    }

    const overrides = {};
    // Backward-compatible: resolve tenant/agency recipients (older callers)
    for (const id of uniqueOverrideIds) {
      if (!id || id === 'UNKNOWN') continue;

      try {
        // Try to resolve recipient type + name (Agency vs Tenant). IDs are distinct, but we handle safely.
        const nameReq = pool.request();
        nameReq.input('Id', sql.UniqueIdentifier, id);
        const nameRes = await nameReq.query(`
          SELECT TOP 1 EntityType, DisplayName
          FROM (
            SELECT 'Agency' as EntityType, AgencyName as DisplayName
            FROM oe.Agencies
            WHERE AgencyId = @Id
            UNION ALL
            SELECT 'Tenant' as EntityType, Name as DisplayName
            FROM oe.Tenants
            WHERE TenantId = @Id
          ) x
        `);

        const resolvedType = nameRes.recordset[0]?.EntityType || null;
        const displayName = nameRes.recordset[0]?.DisplayName || null;

        // ACH destination: attempt Agency then Tenant (masked; no decrypted fields).
        let achAccount = null;
        if (resolvedType === 'Agency') {
          achAccount = await achService.getACHAccount('Agency', id, false);
        } else if (resolvedType === 'Tenant') {
          achAccount = await achService.getACHAccount('Tenant', id, false);
        } else {
          achAccount = (await achService.getACHAccount('Agency', id, false)) || (await achService.getACHAccount('Tenant', id, false));
        }

        overrides[id] = {
          entityType: resolvedType,
          entityId: id,
          displayName,
          achAccountId: achAccount?.ACHAccountId || null,
          bankName: achAccount?.BankName || null,
          accountHolderName: achAccount?.AccountHolderName || null,
          accountType: achAccount?.AccountType || null,
          accountNumberLast4: achAccount?.AccountNumberLast4 || null,
          status: achAccount?.Status || null,
        };
      } catch (e) {
        overrides[id] = {
          entityType: null,
          entityId: id,
          displayName: null,
          achAccountId: null,
          bankName: null,
          accountHolderName: null,
          accountType: null,
          accountNumberLast4: null,
          status: null,
          error: e instanceof Error ? e.message : 'Failed to resolve override destination',
        };
      }
    }

    const overrideAch = {};
    const maskEncryptedDigits = (encryptedValue) => {
      if (!encryptedValue || typeof encryptedValue !== 'string') return null;
      try {
        const decrypted = encryptionService.decrypt(encryptedValue);
        const digitsOnly = decrypted.replace(/\D/g, '');
        if (!digitsOnly) return null;
        const lastFour = digitsOnly.slice(-4);
        return `${'*'.repeat(Math.max(0, digitsOnly.length - 4))}${lastFour}`;
      } catch (error) {
        return null;
      }
    };

    for (const overrideAchId of uniqueOverrideAchIds) {
      try {
        const req1 = pool.request();
        req1.input('OverrideACHId', sql.UniqueIdentifier, overrideAchId);
        const r = await req1.query(`
          SELECT TOP 1
            OverrideACHId,
            TenantId,
            AccountName,
            AccountHolderName,
            BankName,
            BankAccountType,
            IsActive,
            IsDefault,
            VerificationStatus,
            AccountNumberEncrypted,
            RoutingNumberEncrypted
          FROM oe.ProductOverrideACH
          WHERE OverrideACHId = @OverrideACHId
        `);

        const row = r.recordset[0];
        if (!row) {
          overrideAch[overrideAchId] = { overrideAchId, missing: true };
          continue;
        }

        overrideAch[overrideAchId] = {
          overrideAchId: row.OverrideACHId?.toString(),
          tenantId: row.TenantId?.toString() || null,
          accountName: row.AccountName ?? null,
          accountHolderName: row.AccountHolderName ?? null,
          bankName: row.BankName ?? null,
          bankAccountType: row.BankAccountType ?? null,
          isActive: row.IsActive === true || row.IsActive === 1,
          isDefault: row.IsDefault === true || row.IsDefault === 1,
          verificationStatus: row.VerificationStatus ?? null,
          maskedAccountNumber: maskEncryptedDigits(row.AccountNumberEncrypted),
          maskedRoutingNumber: maskEncryptedDigits(row.RoutingNumberEncrypted),
        };
      } catch (e) {
        overrideAch[overrideAchId] = {
          overrideAchId,
          error: e instanceof Error ? e.message : 'Failed to resolve override ACH'
        };
      }
    }

    res.json({ success: true, data: { vendors, overrides, overrideAch } });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Failed to resolve payout destinations'
    });
  }
});

/**
 * @route GET /api/commissions/simulate/rules
 * @desc Get filtered commission rules for simulation based on role
 * @access Agent, TenantAdmin, SysAdmin
 */
router.get('/simulate/rules', authorize(['Agent', 'TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { tenantId } = req.query; // For SysAdmin to filter by tenant
    const userRoles = getUserRoles(req.user);
    
    // Debug logging
    logger.info('Simulation rules request', {
      userId: req.user?.UserId,
      userRoles,
      tenantId: req.user?.TenantId,
      queryTenantId: tenantId
    }, 'Commission');
    
    const pool = await getPool();
    const request = pool.request();

    // For simulator, exclude deleted rules only
    // Locked/Unlocked and EffectiveDate/TerminationDate determine if rule is active
    let whereClause = 'WHERE cr.Status != \'Deleted\'';
    
    // Use currentRole to determine which logic to apply
    const currentRole = req.user.currentRole || 'Member';
    
    if (currentRole === 'Agent' && req.user.AgentId) {
      // Agent: Only their assigned rule + tier-based rules
      let agentTenantId = req.user.TenantId;
      
      // If TenantId not in user object, get it from database
      if (!agentTenantId && req.user.UserId) {
        const userRequest = pool.request();
        userRequest.input('UserId', sql.UniqueIdentifier, req.user.UserId);
        const userResult = await userRequest.query(`
          SELECT TenantId
          FROM oe.Users
          WHERE UserId = @UserId
        `);
        if (userResult.recordset.length > 0) {
          agentTenantId = userResult.recordset[0].TenantId;
        }
      }
      
      if (!agentTenantId) {
        logger.error('Agent missing TenantId', { userId: req.user.UserId, agentId: req.user.AgentId }, 'Commission');
        return res.status(400).json({
          success: false,
          message: 'TenantId not found for agent'
        });
      }
      request.input('AgentId', sql.UniqueIdentifier, req.user.AgentId);
      request.input('TenantId', sql.UniqueIdentifier, agentTenantId);
      
      // Get agent's assigned rule
      const agentRequest = pool.request();
      agentRequest.input('AgentId', sql.UniqueIdentifier, req.user.AgentId);
      const agentResult = await agentRequest.query(`
        SELECT CommissionRuleId
        FROM oe.Agents
        WHERE AgentId = @AgentId
      `);
      const agentRuleId = agentResult.recordset.length > 0 
        ? agentResult.recordset[0].CommissionRuleId 
        : null;

      if (agentRuleId) {
        request.input('AgentRuleId', sql.UniqueIdentifier, agentRuleId);
        whereClause += ` AND (
          cr.RuleId = @AgentRuleId
          OR cr.EntityType = 'Tier'
        ) AND cr.TenantId = @TenantId`;
      } else {
        whereClause += ` AND cr.EntityType = 'Tier' AND cr.TenantId = @TenantId`;
      }
    } else if (currentRole === 'SysAdmin') {
      // SysAdmin: All rules, optionally filtered by tenantId
      if (tenantId) {
        request.input('TenantId', sql.UniqueIdentifier, tenantId);
        whereClause += ` AND cr.TenantId = @TenantId`;
      }
    } else if (currentRole === 'TenantAdmin') {
      // TenantAdmin: Rules for their tenant
      // Also handle users with Agent role but no AgentId (they should be treated as TenantAdmin)
      // TenantAdmin: Rules for their tenant
      let userTenantId = req.user.TenantId;
      
      // If TenantId not in user object, get it from database
      if (!userTenantId && req.user.UserId) {
        const userRequest = pool.request();
        userRequest.input('UserId', sql.UniqueIdentifier, req.user.UserId);
        const userResult = await userRequest.query(`
          SELECT TenantId
          FROM oe.Users
          WHERE UserId = @UserId
        `);
        if (userResult.recordset.length > 0) {
          userTenantId = userResult.recordset[0].TenantId;
        }
      }
      
      if (!userTenantId) {
        logger.error('TenantAdmin missing TenantId', { userId: req.user.UserId }, 'Commission');
        return res.status(400).json({
          success: false,
          message: 'TenantId not found for user'
        });
      }
      request.input('TenantId', sql.UniqueIdentifier, userTenantId);
      whereClause += ` AND cr.TenantId = @TenantId`;
    }

    // Debug logging
    console.log('🔍 SIMULATOR RULES QUERY:', whereClause);
    console.log('🔍 SIMULATOR - TenantId:', req.user?.TenantId);
    console.log('🔍 SIMULATOR - CurrentRole:', currentRole);
    logger.info('🔍 Simulator rules query', {
      whereClause,
      tenantId: req.user?.TenantId,
      currentRole: currentRole,
      queryTenantId: req.query.tenantId
    }, 'Commission');
    
    let result;
    try {
      result = await request.query(`
        SELECT 
          cr.RuleId,
          cr.RuleName,
          cr.ProductId,
          p.Name as ProductName,
          cr.EntityType,
          cr.CommissionType,
          cr.CommissionJson,
          cr.Priority,
          cr.EffectiveDate,
          cr.TerminationDate,
          cr.Locked,
          cr.TenantId,
          CASE 
            WHEN cr.TenantId IS NULL THEN 'Global'
            ELSE t.Name
          END as TenantName,
          CASE 
            WHEN cr.Locked = 1 THEN 'Active'
            ELSE 'Not Active (Unlocked)'
          END as RuleStatus
        FROM oe.CommissionRules cr
        LEFT JOIN oe.Products p ON cr.ProductId = p.ProductId
        LEFT JOIN oe.Tenants t ON cr.TenantId = t.TenantId
        ${whereClause}
        ORDER BY cr.Locked DESC, cr.Priority ASC, cr.EffectiveDate DESC
      `);
      
      console.log('✅ SIMULATOR RESULT - Rule Count:', result.recordset.length);
      console.log('✅ SIMULATOR RESULT - Rule Names:', result.recordset.map(r => r.RuleName).slice(0, 10));
      logger.info('✅ Simulator rules result', {
        ruleCount: result.recordset.length,
        ruleNames: result.recordset.map(r => r.RuleName).slice(0, 10)
      }, 'Commission');
    } catch (dbError) {
      logger.error('Database error fetching simulation rules', { 
        error: dbError.message,
        stack: dbError.stack,
        whereClause,
        user: req.user.UserId 
      }, 'Commission');
      return res.status(400).json({
        success: false,
        message: 'Error fetching rules: ' + dbError.message
      });
    }

    res.json({
      success: true,
      rules: result.recordset
    });

  } catch (error) {
    logger.error('Error fetching simulation rules', { 
      error: error.message,
      stack: error.stack,
      user: req.user?.UserId,
      userRoles: getUserRoles(req.user),
      tenantId: req.user?.TenantId,
      queryTenantId: req.query.tenantId
    }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch simulation rules',
      error: error.message
    });
  }
});

/**
 * @route POST /api/commissions/process-batch
 * @desc Process commission batch
 * @access TenantAdmin, SysAdmin
 */
router.post('/process-batch', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { paymentPeriod, batchType } = req.body;
    
    if (!paymentPeriod) {
      return res.status(400).json({
        success: false,
        message: 'paymentPeriod is required'
      });
    }
    
    const result = await commissionService.processCommissionBatch(
      new Date(paymentPeriod),
      {
        batchType: batchType || 'Regular',
        processedBy: req.user.UserId
      }
    );
    
    logger.info('Commission batch processed', { 
      batchId: result.batchId, 
      processedCount: result.processedCount,
      processedBy: req.user.UserId 
    }, 'Commission');
    
    res.json({
      success: true,
      ...result
    });
    
  } catch (error) {
    logger.error('Error processing commission batch', { error: error.message, user: req.user.UserId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to process commission batch' 
    });
  }
});

/**
 * Phase 2 — DEPRECATED: legacy /api/commissions/chargeback route.
 *
 * Commission chargebacks are now processed via the unified RefundService.processRefund()
 * which clawback orchestration calls CommissionService.clawBackForRefund() inside the
 * refund DB transaction. This route is kept as a 410 Gone shim so any stale callers fail
 * loudly instead of silently invoking the dead processChargeback stored proc.
 */
router.post('/chargeback', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  logger.warn('Deprecated /api/commissions/chargeback called', {
    user: req.user?.UserId,
    body: req.body
  }, 'Commission');
  return res.status(410).json({
    success: false,
    message: 'Deprecated. Process refunds via POST /api/accounting/payments/:paymentId/refund — commission clawback is automatic.',
    code: 'DEPRECATED_CHARGEBACK_ROUTE'
  });
});

/**
 * @route POST /api/commissions/adjustment
 * @desc Create commission adjustment
 * @access TenantAdmin, SysAdmin
 */
router.post('/adjustment', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const adjustmentData = {
      ...req.body,
      createdBy: req.user.UserId
    };
    
    const result = await commissionService.createCommissionAdjustment(adjustmentData);
    
    logger.info('Commission adjustment created', { 
      adjustmentId: result.logId, 
      amount: result.amount,
      createdBy: req.user.UserId 
    }, 'Commission');
    
    res.json({
      success: true,
      ...result
    });
    
  } catch (error) {
    logger.error('Error creating commission adjustment', { error: error.message, user: req.user.UserId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create commission adjustment' 
    });
  }
});

/**
 * ============================================================================
 * Commission Groups
 * ============================================================================
 */

/**
 * @route GET /api/commissions/groups
 * @desc List commission groups for active tenant (paginated, filtered by agent/agency)
 * @query page, limit, search, agentId, agencyId
 * @access Agent, AgencyOwner, TenantAdmin, SysAdmin
 */
router.get('/groups', authorize(['Agent', 'AgencyOwner', 'TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const request = pool.request();
    const tenantId = req.tenantId || req.user?.TenantId;
    const { page = 1, limit = 20, search, agentId, agencyId } = req.query;

    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'tenantId not found for request' });
    }

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    request.input('TenantId', sql.UniqueIdentifier, tenantId);
    request.input('Offset', sql.Int, offset);
    request.input('Limit', sql.Int, limitNum);

    let whereClause = 'cg.TenantId = @TenantId';

    // Filter by agent: groups assigned to this agent (directly or via agency)
    if (agentId) {
      whereClause += ` AND (
        EXISTS (SELECT 1 FROM oe.Agents a WHERE a.CommissionGroupId = cg.CommissionGroupId AND a.AgentId = @AgentId AND a.TenantId = @TenantId)
        OR EXISTS (SELECT 1 FROM oe.Agents a INNER JOIN oe.Agencies ag ON a.AgencyId = ag.AgencyId WHERE a.AgentId = @AgentId AND ag.CommissionGroupId = cg.CommissionGroupId AND a.TenantId = @TenantId)
      )`;
      request.input('AgentId', sql.UniqueIdentifier, agentId);
    }

    // Filter by agency: groups assigned to this agency
    if (agencyId) {
      whereClause += ` AND EXISTS (SELECT 1 FROM oe.Agencies ag WHERE ag.CommissionGroupId = cg.CommissionGroupId AND ag.AgencyId = @AgencyId AND ag.TenantId = @TenantId)`;
      request.input('AgencyId', sql.UniqueIdentifier, agencyId);
    }

    // Search: group name/description, or agent/agency name (groups assigned to agents/agencies matching search)
    if (search && String(search).trim()) {
      const searchPattern = `%${String(search).trim()}%`;
      whereClause += ` AND (
        cg.Name LIKE @Search OR cg.Description LIKE @Search
        OR EXISTS (SELECT 1 FROM oe.Agents a INNER JOIN oe.Users u ON a.UserId = u.UserId WHERE a.CommissionGroupId = cg.CommissionGroupId AND a.TenantId = @TenantId AND (u.FirstName + ' ' + u.LastName LIKE @Search OR u.Email LIKE @Search))
        OR EXISTS (SELECT 1 FROM oe.Agencies ag WHERE ag.CommissionGroupId = cg.CommissionGroupId AND ag.TenantId = @TenantId AND ag.Name LIKE @Search)
      )`;
      request.input('Search', sql.NVarChar(200), searchPattern);
    }

    const countResult = await request.query(`
      SELECT COUNT(*) AS Total
      FROM oe.CommissionGroups cg
      WHERE ${whereClause}
    `);
    const total = countResult.recordset[0]?.Total ?? 0;

    let result;
    try {
      result = await request.query(`
        SELECT
          cg.CommissionGroupId,
          cg.TenantId,
          cg.Name,
          cg.Description,
          cg.Status,
          cg.AgentsCanViewOtherCommissionLevels,
          cg.CreatedDate,
          cg.ModifiedDate,
          (SELECT COUNT(*) FROM oe.CommissionGroupRules cgr WHERE cgr.CommissionGroupId = cg.CommissionGroupId) AS RuleCount
        FROM oe.CommissionGroups cg
        WHERE ${whereClause}
        ORDER BY cg.Name ASC
        OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY
      `);
    } catch (listErr) {
      // DBs that have not applied sql-changes/2026-04-11-commission-groups-agents-view-other-levels.sql
      const msg = listErr && listErr.message ? String(listErr.message) : '';
      if (!msg.includes('AgentsCanViewOtherCommissionLevels') && !msg.includes('Invalid column name')) {
        throw listErr;
      }
      result = await request.query(`
        SELECT
          cg.CommissionGroupId,
          cg.TenantId,
          cg.Name,
          cg.Description,
          cg.Status,
          CAST(0 AS BIT) AS AgentsCanViewOtherCommissionLevels,
          cg.CreatedDate,
          cg.ModifiedDate,
          (SELECT COUNT(*) FROM oe.CommissionGroupRules cgr WHERE cgr.CommissionGroupId = cg.CommissionGroupId) AS RuleCount
        FROM oe.CommissionGroups cg
        WHERE ${whereClause}
        ORDER BY cg.Name ASC
        OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY
      `);
    }

    res.json({
      success: true,
      groups: result.recordset,
      pagination: { page: pageNum, limit: limitNum, total }
    });
  } catch (error) {
    logger.error('Error listing commission groups', { error: error.message, user: req.user?.UserId }, 'Commission');
    res.status(500).json({ success: false, message: 'Failed to fetch commission groups' });
  }
});

/**
 * @route POST /api/commissions/groups
 * @desc Create commission group
 * @access TenantAdmin, SysAdmin
 */
router.post('/groups', authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { name, description, status, agentsCanViewOtherCommissionLevels } = req.body || {};
    const tenantId = req.tenantId || req.user?.TenantId;

    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'tenantId not found for request' });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }

    const pool = await getPool();
    const request = pool.request();
    const groupId = require('uuid').v4();

    request.input('CommissionGroupId', sql.UniqueIdentifier, groupId);
    request.input('TenantId', sql.UniqueIdentifier, tenantId);
    request.input('Name', sql.NVarChar(150), String(name).trim());
    request.input('Description', sql.NVarChar(1000), description ? String(description) : null);
    request.input('Status', sql.NVarChar(20), status ? String(status) : 'Active');
    request.input('AgentsCanViewOtherCommissionLevels', sql.Bit, agentsCanViewOtherCommissionLevels === true ? 1 : 0);
    request.input('CreatedBy', sql.UniqueIdentifier, req.user?.UserId || null);

    await request.query(`
      INSERT INTO oe.CommissionGroups (
        CommissionGroupId, TenantId, Name, Description, Status,
        AgentsCanViewOtherCommissionLevels,
        CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
      ) VALUES (
        @CommissionGroupId, @TenantId, @Name, @Description, @Status,
        @AgentsCanViewOtherCommissionLevels,
        SYSUTCDATETIME(), SYSUTCDATETIME(), @CreatedBy, @CreatedBy
      )
    `);

    res.status(201).json({ success: true, commissionGroupId: groupId });
  } catch (error) {
    logger.error('Error creating commission group', { error: error.message, user: req.user?.UserId }, 'Commission');
    res.status(500).json({ success: false, message: 'Failed to create commission group' });
  }
});

/**
 * @route PUT /api/commissions/groups/:groupId
 * @desc Update commission group
 * @access TenantAdmin, SysAdmin
 */
router.put('/groups/:groupId', authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { name, description, status, agentsCanViewOtherCommissionLevels } = req.body || {};
    const tenantId = req.tenantId || req.user?.TenantId;

    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'tenantId not found for request' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('CommissionGroupId', sql.UniqueIdentifier, groupId);
    request.input('TenantId', sql.UniqueIdentifier, tenantId);
    request.input('ModifiedBy', sql.UniqueIdentifier, req.user?.UserId || null);

    const updateFields = [];
    if (name !== undefined) {
      updateFields.push('Name = @Name');
      request.input('Name', sql.NVarChar(150), String(name).trim());
    }
    if (description !== undefined) {
      updateFields.push('Description = @Description');
      request.input('Description', sql.NVarChar(1000), description === null ? null : String(description));
    }
    if (status !== undefined) {
      updateFields.push('Status = @Status');
      request.input('Status', sql.NVarChar(20), String(status));
    }
    if (agentsCanViewOtherCommissionLevels !== undefined) {
      updateFields.push('AgentsCanViewOtherCommissionLevels = @AgentsCanViewOtherCommissionLevels');
      request.input('AgentsCanViewOtherCommissionLevels', sql.Bit, agentsCanViewOtherCommissionLevels === true ? 1 : 0);
    }

    if (updateFields.length === 0) {
      return res.json({ success: true });
    }

    const result = await request.query(`
      UPDATE oe.CommissionGroups
      SET
        ${updateFields.join(', ')},
        ModifiedDate = SYSUTCDATETIME(),
        ModifiedBy = @ModifiedBy
      WHERE CommissionGroupId = @CommissionGroupId
        AND TenantId = @TenantId;

      SELECT @@ROWCOUNT AS RowsUpdated;
    `);

    const rowsUpdated = result.recordset?.[0]?.RowsUpdated || 0;
    if (rowsUpdated === 0) {
      return res.status(404).json({ success: false, message: 'Commission group not found or access denied' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error updating commission group', { error: error.message, user: req.user?.UserId }, 'Commission');
    res.status(500).json({ success: false, message: 'Failed to update commission group' });
  }
});

/**
 * @route DELETE /api/commissions/groups/:groupId
 * @desc Delete commission group
 * @access TenantAdmin, SysAdmin
 */
router.delete('/groups/:groupId', authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'tenantId not found for request' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('CommissionGroupId', sql.UniqueIdentifier, groupId);
    request.input('TenantId', sql.UniqueIdentifier, tenantId);

    // Block delete if referenced by agents/agencies/codes
    const usage = await request.query(`
      SELECT
        (SELECT COUNT(*) FROM oe.Agents WHERE CommissionGroupId = @CommissionGroupId) AS AgentCount,
        (SELECT COUNT(*) FROM oe.Agencies WHERE CommissionGroupId = @CommissionGroupId) AS AgencyCount,
        (SELECT COUNT(*) FROM oe.OnboardingLinkCommissionCodes WHERE CommissionGroupId = @CommissionGroupId) AS CodeCount
    `);
    const row = usage.recordset?.[0] || {};
    if ((row.AgentCount || 0) > 0 || (row.AgencyCount || 0) > 0 || (row.CodeCount || 0) > 0) {
      return res.status(400).json({
        success: false,
        message: 'Commission group is in use and cannot be deleted',
        usage: { agentCount: row.AgentCount || 0, agencyCount: row.AgencyCount || 0, codeCount: row.CodeCount || 0 }
      });
    }

    await request.query(`
      DELETE FROM oe.CommissionGroupRules WHERE CommissionGroupId = @CommissionGroupId;
      DELETE FROM oe.CommissionGroups WHERE CommissionGroupId = @CommissionGroupId AND TenantId = @TenantId;
    `);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting commission group', { error: error.message, user: req.user?.UserId }, 'Commission');
    res.status(500).json({ success: false, message: 'Failed to delete commission group' });
  }
});

/**
 * @route GET /api/commissions/groups/:groupId/rules
 * @desc Get rules in a commission group
 * @access Agent, AgencyOwner, TenantAdmin, SysAdmin
 */
router.get('/groups/:groupId/rules', authorize(['Agent', 'AgencyOwner', 'TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'tenantId not found for request' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('CommissionGroupId', sql.UniqueIdentifier, groupId);
    request.input('TenantId', sql.UniqueIdentifier, tenantId);

    const result = await request.query(`
      SELECT
        cr.RuleId,
        cr.RuleName,
        cr.ProductId,
        p.Name AS ProductName,
        p.SalesType AS ProductSalesType,
        CAST(ISNULL(p.IsBundle, 0) AS BIT) AS ProductIsBundle,
        p.VendorId AS ProductVendorId,
        pv.VendorName AS ProductVendorName,
        cr.EntityType,
        cr.TierLevel,
        cr.CommissionType,
        cr.CommissionRate,
        cr.FlatAmount,
        cr.CommissionJson,
        cr.Priority,
        cr.EffectiveDate,
        cr.TerminationDate,
        cr.Locked,
        cr.Status,
        cgr.CreatedDate AS AddedDate
      FROM oe.CommissionGroupRules cgr
      INNER JOIN oe.CommissionGroups cg ON cg.CommissionGroupId = cgr.CommissionGroupId
      INNER JOIN oe.CommissionRules cr ON cr.RuleId = cgr.RuleId
      LEFT JOIN oe.Products p ON p.ProductId = cr.ProductId
      LEFT JOIN oe.Vendors pv ON pv.VendorId = p.VendorId
      WHERE cgr.CommissionGroupId = @CommissionGroupId
        AND cg.TenantId = @TenantId
        AND cr.Status != 'Deleted'
      ORDER BY
        CASE WHEN cr.ProductId = '00000000-0000-0000-0000-000000000000' THEN 1 ELSE 0 END ASC,
        p.Name ASC,
        cr.Priority ASC,
        cr.EffectiveDate DESC
    `);

    res.json({ success: true, rules: result.recordset });
  } catch (error) {
    logger.error('Error fetching commission group rules', { error: error.message, user: req.user?.UserId }, 'Commission');
    res.status(500).json({ success: false, message: 'Failed to fetch commission group rules' });
  }
});

/**
 * @route GET /api/commissions/groups/:groupId/available-rules
 * @desc List rules that can be added to a group (Tier/Split, tenant-filtered, excludes already-in-group). Paginated, searchable.
 * @query search, page, limit
 * @access TenantAdmin, SysAdmin
 */
router.get('/groups/:groupId/available-rules', authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { search, page = 1, limit = 20 } = req.query;
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'tenantId not found for request' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('CommissionGroupId', sql.UniqueIdentifier, groupId);

    // Resolve tenant from group (ensures we only show rules for the group's tenant)
    const groupCheck = await pool.request()
      .input('CommissionGroupId', sql.UniqueIdentifier, groupId)
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .query(`SELECT TenantId FROM oe.CommissionGroups WHERE CommissionGroupId = @CommissionGroupId AND TenantId = @TenantId`);
    if (groupCheck.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Commission group not found or access denied' });
    }
    const groupTenantId = groupCheck.recordset[0].TenantId;
    request.input('TenantId', sql.UniqueIdentifier, groupTenantId);

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(String(limit), 10) || 20));
    const offset = (pageNum - 1) * limitNum;
    request.input('Offset', sql.Int, offset);
    request.input('Limit', sql.Int, limitNum);

    let whereClause = `
      cr.Status != 'Deleted'
      AND (cr.EntityType = 'Tier' OR cr.EntityType = 'Split')
      AND (cr.TenantId = @TenantId OR cr.TenantId IS NULL)
      AND cr.RuleId NOT IN (SELECT RuleId FROM oe.CommissionGroupRules WHERE CommissionGroupId = @CommissionGroupId)
      AND NOT EXISTS (
        SELECT 1 FROM oe.CommissionGroupRules cgr2
        INNER JOIN oe.CommissionRules cr2 ON cr2.RuleId = cgr2.RuleId
        WHERE cgr2.CommissionGroupId = @CommissionGroupId
          AND cr2.Status != 'Deleted'
          AND cr2.ProductId = cr.ProductId
          AND (cr2.TierLevel = cr.TierLevel OR (cr2.TierLevel IS NULL AND cr.TierLevel IS NULL))
      )
    `;

    if (search && String(search).trim()) {
      const searchPattern = `%${String(search).trim()}%`;
      request.input('Search', sql.NVarChar(200), searchPattern);
      whereClause += ` AND (cr.RuleName LIKE @Search OR p.Name LIKE @Search)`;
    }

    const countResult = await request.query(`
      SELECT COUNT(*) AS Total
      FROM oe.CommissionRules cr
      LEFT JOIN oe.Products p ON cr.ProductId = p.ProductId
      WHERE ${whereClause}
    `);
    const total = countResult.recordset[0]?.Total ?? 0;

    const result = await request.query(`
      SELECT
        cr.RuleId,
        cr.RuleName,
        cr.ProductId,
        p.Name AS ProductName,
        cr.EntityType,
        cr.TierLevel,
        cr.CommissionType,
        cr.CommissionRate,
        cr.FlatAmount,
        cr.CommissionJson,
        cr.Locked,
        cr.EffectiveDate,
        cr.TerminationDate
      FROM oe.CommissionRules cr
      LEFT JOIN oe.Products p ON cr.ProductId = p.ProductId
      WHERE ${whereClause}
      ORDER BY cr.RuleName ASC
      OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY
    `);

    res.json({
      success: true,
      rules: result.recordset,
      pagination: { page: pageNum, limit: limitNum, total }
    });
  } catch (error) {
    logger.error('Error fetching available rules for group', { error: error.message, user: req.user?.UserId }, 'Commission');
    res.status(500).json({ success: false, message: 'Failed to fetch available rules' });
  }
});

/**
 * @route POST /api/commissions/groups/:groupId/rules
 * @desc Add rule to a commission group. Duplicate = same ProductId AND same TierLevel.
 *      Allows multiple All Products rules (one per tier: Agent, GA, Agency) and multiple
 *      product-specific rules (one per tier per product). Rejects only exact duplicates.
 * @access TenantAdmin, SysAdmin
 */
router.post('/groups/:groupId/rules', authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { ruleId } = req.body || {};
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'tenantId not found for request' });
    }
    if (!ruleId) {
      return res.status(400).json({ success: false, message: 'ruleId is required' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('CommissionGroupId', sql.UniqueIdentifier, groupId);
    request.input('RuleId', sql.UniqueIdentifier, ruleId);
    request.input('TenantId', sql.UniqueIdentifier, tenantId);
    request.input('CreatedBy', sql.UniqueIdentifier, req.user?.UserId || null);

    // Validate rule exists and is compatible with tenant (tenant rule or global)
    const ruleInfo = await request.query(`
      SELECT TOP 1
        cr.RuleId,
        cr.ProductId,
        cr.TierLevel,
        cr.TenantId,
        cr.Status,
        cr.agentid,
        cr.agencyId,
        cr.EntityType
      FROM oe.CommissionRules cr
      WHERE cr.RuleId = @RuleId AND cr.Status != 'Deleted'
    `);
    if (ruleInfo.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Commission rule not found' });
    }
    const rule = ruleInfo.recordset[0];
    if (rule.TenantId != null && rule.TenantId.toString().toUpperCase() !== tenantId.toString().toUpperCase()) {
      return res.status(400).json({ success: false, message: 'Rule tenant does not match group tenant' });
    }

    // Ensure group exists in tenant
    const groupCheck = await request.query(`
      SELECT 1
      FROM oe.CommissionGroups
      WHERE CommissionGroupId = @CommissionGroupId AND TenantId = @TenantId
    `);
    if (groupCheck.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Commission group not found or access denied' });
    }

    const allProductsGuid = '00000000-0000-0000-0000-000000000000';
    request.input('ProductId', sql.UniqueIdentifier, rule.ProductId);
    request.input('TierLevel', TIER_LEVEL_SQL, rule.TierLevel ?? null);

    // Enforce: max 1 rule per (ProductId, TierLevel) within group.
    // Allows multiple All Products rules (one per tier: Agent, GA, Agency, etc.)
    // and multiple product-specific rules (one per tier per product).
    // Duplicate = same product AND same tier level.
    const conflict = await request.query(`
      SELECT TOP 1
        cr2.RuleId,
        cr2.RuleName,
        cr2.ProductId,
        cr2.TierLevel
      FROM oe.CommissionGroupRules cgr2
      INNER JOIN oe.CommissionRules cr2 ON cr2.RuleId = cgr2.RuleId
      WHERE cgr2.CommissionGroupId = @CommissionGroupId
        AND cr2.Status != 'Deleted'
        AND cr2.ProductId = @ProductId
        AND (cr2.TierLevel = @TierLevel OR (cr2.TierLevel IS NULL AND @TierLevel IS NULL))
    `);

    if (conflict.recordset.length > 0) {
      const c = conflict.recordset[0];
      const productDesc = c.ProductId?.toString?.() === allProductsGuid ? 'all-products' : 'this product';
      const tierDesc = c.TierLevel != null ? ` at tier level ${c.TierLevel}` : '';
      return res.status(400).json({
        success: false,
        message: `Commission group already has a ${productDesc} rule${tierDesc}`,
        conflict: {
          ruleId: c.RuleId,
          ruleName: c.RuleName,
          productId: c.ProductId,
          tierLevel: c.TierLevel
        }
      });
    }

    // Add membership (idempotent)
    await request.query(`
      IF NOT EXISTS (
        SELECT 1 FROM oe.CommissionGroupRules
        WHERE CommissionGroupId = @CommissionGroupId AND RuleId = @RuleId
      )
      BEGIN
        INSERT INTO oe.CommissionGroupRules (CommissionGroupId, RuleId, CreatedDate, CreatedBy)
        VALUES (@CommissionGroupId, @RuleId, SYSUTCDATETIME(), @CreatedBy)
      END
    `);

    res.status(201).json({ success: true });
  } catch (error) {
    logger.error('Error adding rule to commission group', { error: error.message, user: req.user?.UserId }, 'Commission');
    res.status(500).json({ success: false, message: 'Failed to add rule to commission group' });
  }
});

/**
 * @route DELETE /api/commissions/groups/:groupId/rules/:ruleId
 * @desc Remove rule from a commission group
 * @access TenantAdmin, SysAdmin
 */
router.delete('/groups/:groupId/rules/:ruleId', authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, ruleId } = req.params;
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'tenantId not found for request' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('CommissionGroupId', sql.UniqueIdentifier, groupId);
    request.input('RuleId', sql.UniqueIdentifier, ruleId);
    request.input('TenantId', sql.UniqueIdentifier, tenantId);

    // Ensure group belongs to tenant
    const groupCheck = await request.query(`
      SELECT 1
      FROM oe.CommissionGroups
      WHERE CommissionGroupId = @CommissionGroupId AND TenantId = @TenantId
    `);
    if (groupCheck.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Commission group not found or access denied' });
    }

    await request.query(`
      DELETE FROM oe.CommissionGroupRules
      WHERE CommissionGroupId = @CommissionGroupId AND RuleId = @RuleId
    `);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error removing rule from commission group', { error: error.message, user: req.user?.UserId }, 'Commission');
    res.status(500).json({ success: false, message: 'Failed to remove rule from commission group' });
  }
});

/**
 * @route GET /api/commissions/rules
 * @desc Get commission rules (filtered by role and tenant)
 * @access Agent, TenantAdmin, SysAdmin
 * 
 * Access rules:
 * - SysAdmin: Can see all commission rules
 * - TenantAdmin: Can see rules for their tenant and agents/agencies under that tenant
 * - Agent: Can only see rules that belong to them (EntityId = AgentId or EntityType = 'Tier')
 */
router.get('/rules', authorize(['Agent', 'TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { productId, entityType, entityId, status } = req.query;
    
    const pool = await getPool();
    const request = pool.request();
    const currentRole = req.user.currentRole || 'Member';
    
    // Start with status filter (exclude deleted) - same as simulator
    let whereClause = 'WHERE cr.Status != \'Deleted\'';
    
    // Apply role-based filtering using currentRole
    if (currentRole === 'TenantAdmin') {
      // TenantAdmin: Rules for their tenant (same logic as simulator)
      // Show all tenant rules and global rules, including agent-specific rules
      // Use req.tenantId which is set by requireTenantAccess middleware (from x-current-tenant-id header)
      const userTenantId = req.tenantId || req.user.TenantId;
      
      if (!userTenantId) {
        logger.error('TenantAdmin missing TenantId', { userId: req.user.UserId }, 'Commission');
        return res.status(400).json({
          success: false,
          message: 'TenantId not found for user'
        });
      }
      request.input('TenantId', sql.UniqueIdentifier, userTenantId);
      whereClause += ` AND (cr.TenantId = @TenantId OR cr.TenantId IS NULL)`;
    } else if (currentRole === 'Agent' && req.user.AgentId) {
      // Agents can only see rules that belong to them
      // Rules where EntityId = AgentId OR EntityType = 'Tier' (tier-based rules apply to all agents)
      // Use req.tenantId which is set by requireTenantAccess middleware (from x-current-tenant-id header)
      const agentTenantId = req.tenantId || req.user.TenantId;
      
      if (!agentTenantId) {
        logger.error('Agent missing TenantId', { userId: req.user.UserId, agentId: req.user.AgentId }, 'Commission');
        return res.status(400).json({
          success: false,
          message: 'TenantId not found for agent'
        });
      }
      
      request.input('AgentId', sql.UniqueIdentifier, req.user.AgentId);
      request.input('TenantId', sql.UniqueIdentifier, agentTenantId);
      whereClause += ` AND (
        (cr.EntityType = 'Agent' AND cr.agentid = @AgentId)
        OR cr.EntityType = 'Tier'
      ) AND (cr.TenantId = @TenantId OR cr.TenantId IS NULL)`;
    }
    // SysAdmin: No additional filtering - can see all rules
    
    // Status filter: Only used to exclude deleted rules (already in WHERE clause)
    // Locked field and EffectiveDate/TerminationDate determine if rule is active
    if (status) {
      request.input('Status', sql.NVarChar(20), status);
      // Replace the default Status filter with the specific status
      whereClause = whereClause.replace('cr.Status != \'Deleted\'', 'cr.Status = @Status');
    }
    // If status is not specified, we already have 'cr.Status != \'Deleted\'' in the WHERE clause
    
    // Locked filter: Filter by locked status (locked = active, unlocked = not yet active)
    const { locked } = req.query;
    if (locked === 'true' || locked === '1') {
      whereClause += ' AND cr.Locked = 1';
    } else if (locked === 'false' || locked === '0') {
      whereClause += ' AND (cr.Locked = 0 OR cr.Locked IS NULL)';
    }
    // If locked is not specified, show all (locked and unlocked)
    
    if (productId) {
      request.input('ProductId', sql.UniqueIdentifier, productId);
      whereClause += ' AND cr.ProductId = @ProductId';
    }
    
    if (entityType && entityId) {
      // Filter by entity: use only agencyId and agentid (EntityId abandoned)
      request.input('EntityId', sql.UniqueIdentifier, entityId);
      
      if (entityType === 'Agency') {
        // For Agency: rules that have this agency in agencyId, or in agentid (legacy/wrong-column data)
        whereClause += ` AND (cr.agencyId = @EntityId OR cr.agentid = @EntityId)`;
      } else if (entityType === 'Agent') {
        // For Agent: only rules that have this agent in agentid
        whereClause += ` AND cr.agentid = @EntityId`;
      } else {
        // For other entity types (e.g. Tier), filter by EntityType only; scope is tenantId/agencyId/agentid
        request.input('EntityType', sql.NVarChar(20), entityType);
        whereClause += ` AND cr.EntityType = @EntityType`;
      }
    } else if (entityType) {
      request.input('EntityType', sql.NVarChar(20), entityType);
      whereClause += ' AND cr.EntityType = @EntityType';
    } else if (entityId) {
      request.input('EntityId', sql.UniqueIdentifier, entityId);
      // Only agencyId and agentid
      whereClause += ` AND (
        cr.agencyId = @EntityId
        OR cr.agentid = @EntityId
      )`;
    }
    
    // Debug logging
    console.log('🔍 COMMISSION RULES MANAGER QUERY:', whereClause);
    console.log('🔍 COMMISSION RULES MANAGER - TenantId:', req.user?.TenantId);
    console.log('🔍 COMMISSION RULES MANAGER - CurrentRole:', currentRole);
    console.log('🔍 COMMISSION RULES MANAGER - Filters:', {
      productId: req.query.productId,
      entityType: req.query.entityType,
      locked: req.query.locked,
      status: req.query.status
    });
    logger.info('Commission Rules Manager query', {
      whereClause,
      tenantId: req.user?.TenantId,
      currentRole: currentRole,
      productId: req.query.productId,
      entityType: req.query.entityType,
      locked: req.query.locked,
      status: req.query.status
    }, 'Commission');
    
    const result = await request.query(`
      SELECT 
        cr.RuleId,
        cr.RuleName,
        cr.ProductId,
        p.Name as ProductName,
        p.SalesType as ProductSalesType,
        cr.EntityType,
        cr.EntityId,
        cr.agencyId,
        cr.agentid,
        cr.TierLevel,
        cr.CommissionType,
        cr.CommissionRate,
        cr.FlatAmount,
        cr.TieredRates,
        cr.CommissionJson,
        cr.PaymentTiming,
        cr.YearlySchedule,
        cr.MinimumPremium,
        cr.MaximumPremium,
        cr.EffectiveDate,
        cr.TerminationDate,
        cr.Priority,
        cr.Status,
        cr.TenantId,
        cr.GroupId,
        cr.Locked,
        CASE 
          WHEN cr.TenantId IS NULL THEN 'Global'
          ELSE t.Name
        END as TenantName,
        CASE 
          WHEN cr.TenantId IS NULL THEN 1
          ELSE 0
        END as IsGlobal,
        g.Name as GroupName,
        CASE WHEN scope_agency.AgencyId IS NOT NULL THEN scope_agency.AgencyName WHEN scope_agency_legacy.AgencyId IS NOT NULL THEN scope_agency_legacy.AgencyName ELSE NULL END as AgencyName,
        CASE WHEN scope_ag.AgentId IS NOT NULL THEN scope_u.FirstName + ' ' + scope_u.LastName ELSE NULL END as AgentName,
        CASE 
          WHEN scope_ag.AgentId IS NOT NULL THEN scope_u.FirstName + ' ' + scope_u.LastName
          WHEN scope_agency_legacy.AgencyId IS NOT NULL THEN scope_agency_legacy.AgencyName
          WHEN scope_agency.AgencyId IS NOT NULL THEN scope_agency.AgencyName
          WHEN cr.TenantId IS NULL THEN 'Global'
          ELSE COALESCE(t.Name, 'Tenant')
        END as Scope,
        cr.CreatedDate,
        cr.ModifiedDate,
        cr.CreatedBy,
        cr.ModifiedBy
      FROM oe.CommissionRules cr
      LEFT JOIN oe.Products p ON cr.ProductId = p.ProductId
      LEFT JOIN oe.Tenants t ON cr.[TenantId] = t.TenantId
      LEFT JOIN oe.Groups g ON cr.GroupId = g.GroupId
      LEFT JOIN oe.Agencies scope_agency ON cr.[agencyId] = scope_agency.AgencyId
      LEFT JOIN oe.Agencies scope_agency_legacy ON cr.[agentid] = scope_agency_legacy.AgencyId
      LEFT JOIN oe.Agents scope_ag ON cr.[agentid] = scope_ag.AgentId
      LEFT JOIN oe.Users scope_u ON scope_ag.UserId = scope_u.UserId
      ${whereClause}
      ORDER BY cr.Priority, cr.EffectiveDate DESC
    `);
    
    console.log('✅ COMMISSION RULES MANAGER RESULT - Rule Count:', result.recordset.length);
    console.log('✅ COMMISSION RULES MANAGER RESULT - Rule Names:', result.recordset.map(r => r.RuleName).slice(0, 10));
    logger.info('Commission Rules Manager result', {
      ruleCount: result.recordset.length,
      ruleNames: result.recordset.map(r => r.RuleName)
    }, 'Commission');
    
    res.json({
      success: true,
      rules: result.recordset
    });
    
  } catch (error) {
    logger.error('Error fetching commission rules', { error: error.message, user: req.user.UserId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch commission rules' 
    });
  }
});

/**
 * @route POST /api/commissions/rules/batch
 * @desc Get multiple commission rules by IDs (batch request)
 * @access Agent, TenantAdmin, SysAdmin
 */
router.post('/rules/batch', authorize(['Agent', 'TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { ruleIds } = req.body;
    
    if (!Array.isArray(ruleIds) || ruleIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'ruleIds must be a non-empty array'
      });
    }
    
    // Limit batch size to prevent abuse
    if (ruleIds.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Maximum 100 ruleIds allowed per batch request'
      });
    }
    
    const pool = await getPool();
    const request = pool.request();
    
    // Create table-valued parameter for ruleIds
    // Since SQL Server doesn't support array parameters directly, we'll use IN clause
    // Convert ruleIds to unique identifiers and filter out invalid ones
    const validRuleIds = ruleIds.filter(id => id && typeof id === 'string');
    
    if (validRuleIds.length === 0) {
      return res.json({
        success: true,
        rules: []
      });
    }
    
    // Build IN clause with parameterized values
    // For SQL Server, we can use a table-valued parameter or build a dynamic IN clause
    // Using a simpler approach: create parameters for each ID
    let inClause = '';
    validRuleIds.forEach((ruleId, index) => {
      const paramName = `RuleId${index}`;
      request.input(paramName, sql.UniqueIdentifier, ruleId);
      inClause += (index > 0 ? ', ' : '') + `@${paramName}`;
    });
    
    // Apply tenant filter for non-SysAdmin users
    let whereClause = `WHERE cr.RuleId IN (${inClause}) AND cr.Status != 'Deleted'`;
    if (getUserRoles(req.user).includes('TenantAdmin') || getUserRoles(req.user).includes('Agent')) {
      request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      whereClause += ' AND (cr.TenantId = @TenantId OR cr.TenantId IS NULL)';
    }
    
    const result = await request.query(`
      SELECT 
        cr.RuleId,
        cr.RuleName,
        cr.ProductId,
        p.Name as ProductName,
        cr.EntityType,
        cr.EntityId,
        cr.TierLevel,
        cr.CommissionType,
        cr.CommissionRate,
        cr.FlatAmount,
        cr.TieredRates,
        cr.CommissionJson,
        cr.PaymentTiming,
        cr.YearlySchedule,
        cr.MinimumPremium,
        cr.MaximumPremium,
        cr.EffectiveDate,
        cr.TerminationDate,
        cr.Priority,
        cr.Status,
        cr.TenantId,
        cr.GroupId,
        cr.Locked,
        CASE 
          WHEN cr.TenantId IS NULL THEN 'Global'
          ELSE t.Name
        END as TenantName,
        CASE 
          WHEN cr.TenantId IS NULL THEN 1
          ELSE 0
        END as IsGlobal,
        g.Name as GroupName,
        cr.CreatedDate,
        cr.ModifiedDate,
        cr.CreatedBy,
        cr.ModifiedBy
      FROM oe.CommissionRules cr
      LEFT JOIN oe.Products p ON cr.ProductId = p.ProductId
      LEFT JOIN oe.Tenants t ON cr.TenantId = t.TenantId
      LEFT JOIN oe.Groups g ON cr.GroupId = g.GroupId
      ${whereClause}
      ORDER BY cr.Priority, cr.EffectiveDate DESC
    `);
    
    res.json({
      success: true,
      rules: result.recordset
    });
    
  } catch (error) {
    logger.error('Error fetching commission rules batch', { 
      error: error.message, 
      user: req.user.UserId,
      ruleIdsCount: req.body.ruleIds?.length 
    }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch commission rules' 
    });
  }
});

/**
 * @route POST /api/commissions/rules/group-memberships
 * @desc For each rule ID, list commission groups (same tenant) that include that rule.
 * @access TenantAdmin, SysAdmin
 */
router.post('/rules/group-memberships', authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const ruleIds = req.body.ruleIds;
    if (!Array.isArray(ruleIds) || ruleIds.length === 0) {
      return res.status(400).json({ success: false, message: 'ruleIds array required' });
    }
    if (ruleIds.length > 100) {
      return res.status(400).json({ success: false, message: 'Too many rule IDs' });
    }

    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'tenantId not found for request' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('TenantId', sql.UniqueIdentifier, tenantId);

    const placeholders = [];
    ruleIds.forEach((id, i) => {
      const param = `R${i}`;
      request.input(param, sql.UniqueIdentifier, id);
      placeholders.push(`@${param}`);
    });

    const result = await request.query(`
      SELECT cr.RuleId, cgr.CommissionGroupId, cg.Name AS GroupName
      FROM oe.CommissionRules cr
      INNER JOIN oe.CommissionGroupRules cgr ON cgr.RuleId = cr.RuleId
      INNER JOIN oe.CommissionGroups cg ON cg.CommissionGroupId = cgr.CommissionGroupId
      WHERE cr.RuleId IN (${placeholders.join(', ')})
        AND cg.TenantId = @TenantId
        AND cr.Status != 'Deleted'
    `);

    const map = {};
    for (const row of result.recordset) {
      const rid = String(row.RuleId).toLowerCase();
      if (!map[rid]) map[rid] = [];
      map[rid].push({
        CommissionGroupId: row.CommissionGroupId,
        Name: row.GroupName,
      });
    }

    const memberships = ruleIds.map((id) => ({
      ruleId: id,
      groups: map[String(id).toLowerCase()] || [],
    }));

    res.json({ success: true, memberships });
  } catch (error) {
    logger.error('Error fetching rule group memberships', { error: error.message }, 'Commission');
    res.status(500).json({ success: false, message: 'Failed to fetch group memberships' });
  }
});

/**
 * @route GET /api/commissions/rules/:ruleId
 * @desc Get single commission rule by ID
 * @access Agent, TenantAdmin, SysAdmin
 */
router.get('/rules/:ruleId', authorize(['Agent', 'TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { ruleId } = req.params;
    const pool = await getPool();
    const request = pool.request();
    
    request.input('RuleId', sql.UniqueIdentifier, ruleId);
    
    // Apply tenant filter for non-SysAdmin users
    // Exclude deleted rules (Status='Deleted'), but active status is determined by Locked+EffectiveDate
    let whereClause = 'WHERE cr.RuleId = @RuleId AND cr.Status != \'Deleted\'';
    if (getUserRoles(req.user).includes('TenantAdmin') || getUserRoles(req.user).includes('Agent')) {
      const tenantId = req.tenantId || req.user?.TenantId;
      request.input('TenantId', sql.UniqueIdentifier, tenantId);
      whereClause += ' AND (cr.TenantId = @TenantId OR cr.TenantId IS NULL)';
    }
    
    const result = await request.query(`
      SELECT 
        cr.RuleId,
        cr.RuleName,
        cr.ProductId,
        p.Name as ProductName,
        cr.EntityType,
        cr.EntityId,
        cr.TierLevel,
        cr.CommissionType,
        cr.CommissionRate,
        cr.FlatAmount,
        cr.TieredRates,
        cr.CommissionJson,
        cr.PaymentTiming,
        cr.YearlySchedule,
        cr.MinimumPremium,
        cr.MaximumPremium,
        cr.EffectiveDate,
        cr.TerminationDate,
        cr.Priority,
        cr.Status,
        cr.TenantId,
        cr.GroupId,
        cr.Locked,
        CASE 
          WHEN cr.TenantId IS NULL THEN 'Global'
          ELSE t.Name
        END as TenantName,
        CASE 
          WHEN cr.TenantId IS NULL THEN 1
          ELSE 0
        END as IsGlobal,
        g.Name as GroupName,
        cr.CreatedDate,
        cr.ModifiedDate,
        cr.CreatedBy,
        cr.ModifiedBy
      FROM oe.CommissionRules cr
      LEFT JOIN oe.Products p ON cr.ProductId = p.ProductId
      LEFT JOIN oe.Tenants t ON cr.TenantId = t.TenantId
      LEFT JOIN oe.Groups g ON cr.GroupId = g.GroupId
      ${whereClause}
    `);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Commission rule not found or access denied'
      });
    }
    
    res.json({
      success: true,
      rule: result.recordset[0]
    });
    
  } catch (error) {
    logger.error('Error fetching commission rule', { error: error.message, user: req.user.UserId, ruleId: req.params.ruleId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch commission rule' 
    });
  }
});

/**
 * @route POST /api/commissions/rules
 * @desc Create commission rule (with tenant support)
 * @access TenantAdmin, SysAdmin
 */
router.post('/rules', authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    console.log('💰 [CREATE-RULE] Received request:', {
      body: req.body,
      user: req.user?.Email
    });
    
    const {
      ruleName,
      productId,
      entityType,
      entityId,
      tierLevel,
      commissionType,
      commissionRate,
      flatAmount,
      commissionJson,
      paymentTiming,
      yearlySchedule,
      minimumPremium,
      maximumPremium,
      effectiveDate,
      terminationDate,
      priority,
      status,
      tenantId, // Only used by SysAdmin
      groupId, // For group-specific rules (e.g., Split Commission Rule)
      locked // Locked status (defaults to false)
    } = req.body;
    
    if (!ruleName || !productId || !entityType || !commissionType || !effectiveDate) {
      return res.status(400).json({
        success: false,
        message: 'ruleName, productId, entityType, commissionType, and effectiveDate are required'
      });
    }
    
    // Normalize entityType so Agency/Agent always map to correct column (agencyId vs agentid)
    const normalizedEntityType = typeof entityType === 'string'
      ? entityType.charAt(0).toUpperCase() + entityType.slice(1).toLowerCase()
      : entityType;

    // Commission Groups define scope; rules cannot be authored as agent-specific or agency-specific.
    if (normalizedEntityType === 'Agent' || normalizedEntityType === 'Agency') {
      return res.status(400).json({
        success: false,
        message: 'Agent/Agency-scoped rules are deprecated. Create unscoped Tier/Split rules and assign scope via Commission Groups.'
      });
    }
    
    const pool = await getPool();
    const request = pool.request();
    
    const ruleId = require('uuid').v4();
    
    console.log('💰 [CREATE-RULE] Processing productId:', {
      received: productId,
      isGeneric: productId === '00000000-0000-0000-0000-000000000000'
    });
    
    request.input('RuleId', sql.UniqueIdentifier, ruleId);
    request.input('RuleName', sql.NVarChar(100), ruleName);
    request.input('ProductId', sql.UniqueIdentifier, productId);
    request.input('EntityType', sql.NVarChar(20), normalizedEntityType);
    request.input('EntityId', sql.UniqueIdentifier, null); // deprecated; scope is agencyId/agentid only
    request.input('TierLevel', TIER_LEVEL_SQL, tierLevel || null);
    request.input('CommissionType', sql.NVarChar(50), commissionType);
    request.input('CommissionRate', sql.Decimal(5, 4), commissionRate || null);
    request.input('FlatAmount', sql.Decimal(10, 2), flatAmount || null);
    request.input('CommissionJson', sql.NVarChar(sql.MAX), commissionJson || null);
    request.input('PaymentTiming', sql.NVarChar(50), paymentTiming || 'Initial');
    request.input('YearlySchedule', sql.NVarChar(sql.MAX), yearlySchedule || null);
    request.input('MinimumPremium', sql.Decimal(10, 2), minimumPremium || null);
    request.input('MaximumPremium', sql.Decimal(10, 2), maximumPremium || null);
    request.input('EffectiveDate', sql.Date, effectiveDate);
    request.input('TerminationDate', sql.Date, terminationDate || null);
    request.input('Priority', sql.Int, priority || 100);
    // Status field is deprecated - rules are active if Locked=1 AND EffectiveDate<=Today
    // Set Status to 'Active' for backward compatibility, but it's not used for determining if rule is active
    request.input('Status', sql.NVarChar(20), 'Active');
    request.input('GroupId', sql.UniqueIdentifier, groupId || null);
    request.input('Locked', sql.Bit, locked === true ? 1 : 0);
    request.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
    
    // Handle tenant assignment
    // REQUIRED behavior:
    // - SysAdmin: may create global rules (TenantId = NULL) or tenant-scoped rules (TenantId provided)
    // - TenantAdmin: ALWAYS tenant-scoped, forced to active tenant (supports tenant switching via x-current-tenant-id)
    let finalTenantId = null;
    const isTenantAdminRole = getUserRoles(req.user).includes('TenantAdmin');
    const isSysAdminRole = getUserRoles(req.user).includes('SysAdmin');
    if (isTenantAdminRole) {
      // Force to active tenant. requireTenantAccess sets req.tenantId using x-current-tenant-id when present.
      finalTenantId = req.tenantId || req.user.TenantId;
      if (!finalTenantId) {
        return res.status(400).json({ success: false, message: 'TenantId not found for TenantAdmin' });
      }
      request.input('TenantId', sql.UniqueIdentifier, finalTenantId);
    } else if (isSysAdminRole) {
      // SysAdmin: Can choose tenant or leave null for global
      finalTenantId = tenantId || null;
      request.input('TenantId', sql.UniqueIdentifier, finalTenantId);
    }
    
    // Resolve agencyId/agentid from request entityId for duplicate check and insert (EntityId deprecated)
    let dupAgencyId = null;
    let dupAgentId = null;
    if (entityId) {
      if (normalizedEntityType === 'Override') {
        dupAgentId = entityId;
      }
    }

    // Check for duplicate rules: same product, entity type, commission type, priority, tenant, 
    // commission amounts/rates (or CommissionJson for complex rules), and scope (agencyId/agentid)
    const duplicateCheckRequest = pool.request();
    duplicateCheckRequest.input('ProductId', sql.UniqueIdentifier, productId);
    duplicateCheckRequest.input('EntityType', sql.NVarChar(20), normalizedEntityType);
    duplicateCheckRequest.input('CommissionType', sql.NVarChar(50), commissionType);
    duplicateCheckRequest.input('Priority', sql.Int, priority || 100);
    duplicateCheckRequest.input('TenantId', sql.UniqueIdentifier, finalTenantId);
    duplicateCheckRequest.input('GroupId', sql.UniqueIdentifier, groupId || null);
    duplicateCheckRequest.input('DupAgencyId', sql.UniqueIdentifier, dupAgencyId);
    duplicateCheckRequest.input('DupAgentId', sql.UniqueIdentifier, dupAgentId);
    
    // Build the duplicate check query based on entity type (use agencyId/agentid only)
    let duplicateCheckQuery = `
      SELECT RuleId, RuleName, Status, CommissionRate, FlatAmount, CommissionJson
      FROM oe.CommissionRules
      WHERE ProductId = @ProductId
        AND EntityType = @EntityType
        AND CommissionType = @CommissionType
        AND Priority = @Priority
        AND (TenantId = @TenantId OR (TenantId IS NULL AND @TenantId IS NULL))
        AND (GroupId = @GroupId OR (GroupId IS NULL AND @GroupId IS NULL))
        AND (agencyId = @DupAgencyId OR (agencyId IS NULL AND @DupAgencyId IS NULL))
        AND (agentid = @DupAgentId OR (agentid IS NULL AND @DupAgentId IS NULL))
    `;
    
    // For Tier entity type, also check tierLevel
    if (normalizedEntityType === 'Tier') {
      duplicateCheckRequest.input('TierLevel', TIER_LEVEL_SQL, tierLevel || null);
      duplicateCheckQuery += ` AND (TierLevel = @TierLevel OR (TierLevel IS NULL AND @TierLevel IS NULL))`;
    }
    
    // Add commission amount/rate or JSON comparison based on commission type
    if (commissionType === 'Percentage') {
      duplicateCheckRequest.input('CommissionRate', sql.Decimal(5, 4), commissionRate || null);
      duplicateCheckQuery += ` AND (CommissionRate = @CommissionRate OR (CommissionRate IS NULL AND @CommissionRate IS NULL))`;
    } else if (commissionType === 'Flat') {
      duplicateCheckRequest.input('FlatAmount', sql.Decimal(10, 2), flatAmount || null);
      duplicateCheckQuery += ` AND (FlatAmount = @FlatAmount OR (FlatAmount IS NULL AND @FlatAmount IS NULL))`;
    } else if (commissionType === 'Tiered' || commissionType === 'Split') {
      // For Tiered and Split, compare CommissionJson
      // Normalize the JSON by parsing and stringifying to handle formatting differences
      let normalizedCommissionJson = null;
      if (commissionJson) {
        try {
          const parsed = typeof commissionJson === 'string' ? JSON.parse(commissionJson) : commissionJson;
          // Sort keys for consistent comparison
          normalizedCommissionJson = JSON.stringify(parsed, Object.keys(parsed).sort());
        } catch (e) {
          // If JSON is invalid, use as-is
          normalizedCommissionJson = typeof commissionJson === 'string' ? commissionJson : JSON.stringify(commissionJson);
        }
      }
      duplicateCheckRequest.input('CommissionJson', sql.NVarChar(sql.MAX), normalizedCommissionJson);
      // Compare normalized JSON strings
      duplicateCheckQuery += ` AND (
        (CommissionJson = @CommissionJson) OR 
        (CommissionJson IS NULL AND @CommissionJson IS NULL)
      )`;
    }
    
    // Check for duplicates only among active rules (Locked=1 AND EffectiveDate<=Today)
    duplicateCheckQuery += ` AND Locked = 1 AND EffectiveDate <= CAST(GETDATE() AS DATE)`;
    
    const duplicateResult = await duplicateCheckRequest.query(duplicateCheckQuery);
    
    // For Tiered/Split, do additional JSON comparison in JavaScript to handle formatting differences
    if ((commissionType === 'Tiered' || commissionType === 'Split') && duplicateResult.recordset.length > 0) {
      let normalizedNewJson = null;
      if (commissionJson) {
        try {
          const parsed = typeof commissionJson === 'string' ? JSON.parse(commissionJson) : commissionJson;
          normalizedNewJson = JSON.stringify(parsed, Object.keys(parsed).sort());
        } catch (e) {
          normalizedNewJson = typeof commissionJson === 'string' ? commissionJson : JSON.stringify(commissionJson);
        }
      }
      
      // Filter results to only those with matching JSON content
      const exactMatches = duplicateResult.recordset.filter(rule => {
        if (!normalizedNewJson && !rule.CommissionJson) return true;
        if (!normalizedNewJson || !rule.CommissionJson) return false;
        
        try {
          const existingParsed = typeof rule.CommissionJson === 'string' 
            ? JSON.parse(rule.CommissionJson) 
            : rule.CommissionJson;
          const normalizedExisting = JSON.stringify(existingParsed, Object.keys(existingParsed).sort());
          return normalizedExisting === normalizedNewJson;
        } catch (e) {
          // If JSON parsing fails, do direct string comparison
          return rule.CommissionJson === normalizedNewJson;
        }
      });
      
      if (exactMatches.length > 0) {
        const existingRule = exactMatches[0];
        return res.status(409).json({
          success: false,
          message: `A duplicate commission rule already exists: "${existingRule.RuleName}" (${existingRule.RuleId}). Please use a different product, entity type, commission type, priority, commission amount/rate, or tenant.`,
          duplicateRuleId: existingRule.RuleId,
          duplicateRuleName: existingRule.RuleName
        });
      }
    } else if (duplicateResult.recordset.length > 0) {
      const existingRule = duplicateResult.recordset[0];
      return res.status(409).json({
        success: false,
        message: `A duplicate commission rule already exists: "${existingRule.RuleName}" (${existingRule.RuleId}). Please use a different product, entity type, commission type, priority, commission amount/rate, or tenant.`,
        duplicateRuleId: existingRule.RuleId,
        duplicateRuleName: existingRule.RuleName
      });
    }
    
    // Use resolved scope (EntityId deprecated; we use agencyId/agentid only). EntityId already set above for INSERT.
    request.input('AgencyId', sql.UniqueIdentifier, dupAgencyId);
    request.input('AgentId', sql.UniqueIdentifier, dupAgentId);

    await request.query(`
      INSERT INTO oe.CommissionRules (
        RuleId, RuleName, ProductId, EntityType, EntityId, TierLevel,
        CommissionType, CommissionRate, FlatAmount, CommissionJson,
        PaymentTiming, YearlySchedule, MinimumPremium, MaximumPremium,
        EffectiveDate, TerminationDate, Priority, Status, TenantId, GroupId, Locked,
        agencyId, agentid,
        CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
      ) VALUES (
        @RuleId, @RuleName, @ProductId, @EntityType, @EntityId, @TierLevel,
        @CommissionType, @CommissionRate, @FlatAmount, @CommissionJson,
        @PaymentTiming, @YearlySchedule, @MinimumPremium, @MaximumPremium,
        @EffectiveDate, @TerminationDate, @Priority, @Status, @TenantId, @GroupId, @Locked,
        @AgencyId, @AgentId,
        GETUTCDATE(), GETUTCDATE(), @CreatedBy, @CreatedBy
      )
    `);
    
    logger.info('Commission rule created', { 
      ruleId, 
      ruleName, 
      productId,
      tenantId: request.parameters.TenantId?.value,
      createdBy: req.user.UserId 
    }, 'Commission');
    
    res.json({
      success: true,
      ruleId,
      message: 'Commission rule created successfully'
    });
    
  } catch (error) {
    console.error('❌ [CREATE-RULE] Error creating commission rule:', {
      error: error.message,
      stack: error.stack,
      sqlMessage: error.originalError?.info?.message,
      user: req.user.UserId
    });
    logger.error('Error creating commission rule', { error: error.message, user: req.user.UserId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create commission rule',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route PUT /api/commissions/rules/:ruleId
 * @desc Update commission rule (with tenant permission check)
 * @access TenantAdmin (own tenant rules only), SysAdmin
 */
router.put('/rules/:ruleId', authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { ruleId } = req.params;
    const pool = await getPool();
    
    // First check if rule exists and get its tenant
    const checkRequest = pool.request();
    checkRequest.input('RuleId', sql.UniqueIdentifier, ruleId);
    
    const checkResult = await checkRequest.query(`
      SELECT TenantId, RuleName, Locked 
      FROM oe.CommissionRules 
      WHERE RuleId = @RuleId
    `);
    
    if (checkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Commission rule not found'
      });
    }
    
    const rule = checkResult.recordset[0];
    
    // Check permissions
    if (getUserRoles(req.user).includes('TenantAdmin')) {
      // TenantAdmin can only edit rules for the active tenant (supports tenant switching)
      const activeTenantId = req.tenantId || req.user.TenantId;
      if (rule.TenantId !== activeTenantId) {
        return res.status(403).json({
          success: false,
          message: 'You can only edit rules for your own tenant'
        });
      }
      // TenantAdmin cannot edit global rules
      if (rule.TenantId === null) {
        return res.status(403).json({
          success: false,
          message: 'You cannot edit global commission rules'
        });
      }
    }
    
    // Check if rule is locked
    const isLocked = rule.Locked === true || rule.Locked === 1;
    
    // If rule is locked, prevent unlocking it
    if (isLocked && req.body.hasOwnProperty('locked') && req.body.locked === false) {
      return res.status(403).json({
        success: false,
        message: 'Cannot unlock a locked commission rule. Once locked, a rule cannot be unlocked.'
      });
    }
    
    // Build dynamic update query
    const request = pool.request();
    const updateFields = [];
    const allowedFields = [
      'RuleName', 'ProductId', 'TierLevel', 'CommissionType',
      'CommissionRate', 'FlatAmount', 'CommissionJson', 'PaymentTiming',
      'YearlySchedule', 'MinimumPremium', 'MaximumPremium',
      'EffectiveDate', 'TerminationDate', 'Priority', 'Status', 'GroupId',
      'agencyId', 'agentid' // Scope only; EntityId deprecated
    ];
    
    // Locked rules: unlocking via API is still blocked above. TenantAdmin/SysAdmin may update
    // commission fields (this route is already restricted to those roles).

    // SysAdmin can also update TenantId (only if not locked)
    if (!isLocked && getUserRoles(req.user).includes('SysAdmin') && req.body.hasOwnProperty('tenantId')) {
      allowedFields.push('TenantId');
    }
    
    // Allow setting Locked to true (but not false if already locked - checked above)
    // Also allow setting Locked to false if rule is not currently locked
    if (req.body.hasOwnProperty('locked')) {
      const lockedValue = req.body.locked;
      // Check if we're trying to set it to true (handle boolean true, number 1, string 'true', string '1')
      const isSettingToTrue = lockedValue === true || lockedValue === 1 || lockedValue === 'true' || lockedValue === '1';
      // Check if we're trying to set it to false (handle boolean false, number 0, string 'false', string '0')
      const isSettingToFalse = lockedValue === false || lockedValue === 0 || lockedValue === 'false' || lockedValue === '0';
      
      // Only add if we're setting it to true, or if rule is not locked and we're setting it to false
      if (isSettingToTrue || (!isLocked && isSettingToFalse)) {
        allowedFields.push('Locked');
        console.log('🔒 [UPDATE-RULE] Adding Locked to allowedFields:', {
          lockedValue,
          isSettingToTrue,
          isSettingToFalse,
          isLocked
        });
      } else {
        console.log('🔒 [UPDATE-RULE] NOT adding Locked to allowedFields:', {
          lockedValue,
          isSettingToTrue,
          isSettingToFalse,
          isLocked,
          reason: isLocked ? 'Rule is already locked, cannot unlock' : 'Invalid locked value'
        });
      }
    }
    
    request.input('RuleId', sql.UniqueIdentifier, ruleId);
    request.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
    
    console.log('🔒 [UPDATE-RULE] Processing update:', {
      ruleId,
      isLocked,
      bodyHasLocked: req.body.hasOwnProperty('locked'),
      lockedValue: req.body.locked,
      lockedValueType: typeof req.body.locked,
      allowedFields: allowedFields
    });
    
    for (const field of allowedFields) {
      const camelCase = field.charAt(0).toLowerCase() + field.slice(1);
      if (req.body.hasOwnProperty(camelCase)) {
        updateFields.push(`${field} = @${field}`);
        
        // Add appropriate SQL type based on field
        let sqlType = sql.NVarChar(100);
        if (field.includes('Date')) sqlType = sql.Date;
        else if (field.includes('Rate')) sqlType = sql.Decimal(5, 4);
        else if (field.includes('Premium') || field === 'FlatAmount') sqlType = sql.Decimal(10, 2);
        else if (field === 'TierLevel') sqlType = TIER_LEVEL_SQL;
        else if (field === 'Priority') sqlType = sql.Int;
        else if (field === 'CommissionJson' || field === 'YearlySchedule') sqlType = sql.NVarChar(sql.MAX);
        else if (field === 'ProductId' || field === 'TenantId' || field === 'GroupId' || field === 'agencyId' || field === 'agentid') sqlType = sql.UniqueIdentifier;
        else if (field === 'Locked') sqlType = sql.Bit;
        
        let value = req.body[camelCase];
        if ((field === 'ProductId' || field === 'TenantId' || field === 'GroupId' || field === 'agencyId' || field === 'agentid') && value === '') {
          value = null; // Allow empty string to be converted to null
        }
        // Convert boolean to bit for Locked field
        if (field === 'Locked') {
          value = value === true || value === 1 || value === 'true' ? 1 : 0;
          console.log('🔒 [UPDATE-RULE] Converting Locked value:', {
            original: req.body[camelCase],
            converted: value
          });
        }
        
        // Log scope updates for debugging
        if (field === 'agencyId' || field === 'agentid') {
          console.log('🔍 [UPDATE-RULE] Scope update:', {
            field,
            camelCase,
            value,
            valueType: typeof value,
            hasProperty: req.body.hasOwnProperty(camelCase),
            bodyKeys: Object.keys(req.body)
          });
        }
        
        // Handle agencyId and agentid fields
        if (field === 'agencyId' || field === 'agentid') {
          sqlType = sql.UniqueIdentifier;
        }
        
        request.input(field, sqlType, value);
      }
    }
    
    // When rule is locked, only TerminationDate (and Modified*) are updated — do not touch EntityType/agencyId/agentid
    // Only update scope when the client sends a meaningful entityId or entityType. If the agency dropdown
    // is on a separate endpoint and hasn't loaded in time, the frontend may send entityId: null — we must
    // NOT treat that as "clear scope"; we skip scope update and preserve existing agencyId/agentid.
    const hasMeaningfulEntityId = req.body.hasOwnProperty('entityId') && req.body.entityId != null;
    const hasMeaningfulEntityType = req.body.hasOwnProperty('entityType') && req.body.entityType != null && String(req.body.entityType).trim() !== '';
    const scopeChangeRequested = hasMeaningfulEntityId || hasMeaningfulEntityType;
    if (!isLocked && scopeChangeRequested) {
      // Fetch current EntityType and scope (agencyId/agentid); EntityId is deprecated
      let ruleEntityType = rule.EntityType;
      let ruleAgencyId = rule.agencyId;
      let ruleAgentId = rule.agentid;
      if (ruleEntityType === undefined || (ruleAgencyId === undefined && ruleAgentId === undefined)) {
        const detailsResult = await pool.request()
          .input('RuleId', sql.UniqueIdentifier, ruleId)
          .query(`SELECT EntityType, agencyId, agentid FROM oe.CommissionRules WHERE RuleId = @RuleId`);
        if (detailsResult.recordset.length > 0) {
          const row = detailsResult.recordset[0];
          ruleEntityType = row.EntityType;
          ruleAgencyId = row.agencyId ?? row.AgencyId;
          ruleAgentId = row.agentid ?? row.AgentId;
        }
      }
      const rawEntityType = req.body.hasOwnProperty('entityType') ? req.body.entityType : ruleEntityType;
      const entityTypeValue = typeof rawEntityType === 'string'
        ? rawEntityType.charAt(0).toUpperCase() + rawEntityType.slice(1).toLowerCase()
        : rawEntityType;
      // Prefer request body entityId for scope; fallback to current rule's agencyId/agentid
      const entityIdValue = req.body.hasOwnProperty('entityId') ? (req.body.entityId || null) : (ruleAgencyId || ruleAgentId || null);
      
      let agencyIdValue = null;
      let agentIdValue = null;
      
      if (entityIdValue) {
        if (entityTypeValue === 'Agency') {
          agencyIdValue = entityIdValue;
        } else if (entityTypeValue === 'Agent' || entityTypeValue === 'Override') {
          agentIdValue = entityIdValue;
        } else if (entityTypeValue === 'Tier') {
          const entityCheckRequest = pool.request();
          entityCheckRequest.input('EntityId', sql.UniqueIdentifier, entityIdValue);
          const agencyCheck = await entityCheckRequest.query(`
            SELECT AgencyId FROM oe.Agencies WHERE AgencyId = @EntityId
          `);
          if (agencyCheck.recordset.length > 0) {
            agencyIdValue = entityIdValue;
          } else {
            const agentCheck = await entityCheckRequest.query(`
              SELECT AgentId FROM oe.Agents WHERE AgentId = @EntityId
            `);
            if (agentCheck.recordset.length > 0) {
              agentIdValue = entityIdValue;
            }
          }
        }
      }
      
      // EntityType: update when we have a meaningful type
      if (!updateFields.some(f => f.includes('EntityType'))) {
        updateFields.push('EntityType = @EntityType');
        request.input('EntityType', sql.NVarChar(20), entityTypeValue);
      }
      // Only write agencyId/agentid when we have a definite value. If entity type is Agency/Agent/Override
      // but entityId is null (e.g. dropdown didn't load), do NOT overwrite — leave existing scope as-is.
      const scopeValuesDefinite = entityIdValue != null || entityTypeValue === 'Tenant';
      if (scopeValuesDefinite) {
        if (!updateFields.some(f => f.includes('agencyId'))) {
          updateFields.push('agencyId = @AgencyId');
        }
        if (!updateFields.some(f => f.includes('agentid'))) {
          updateFields.push('agentid = @AgentId');
        }
        request.input('AgencyId', sql.UniqueIdentifier, agencyIdValue);
        request.input('AgentId', sql.UniqueIdentifier, agentIdValue);
      }
    }
    
    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }
    
    console.log('🔒 [UPDATE-RULE] Final SQL update:', {
      updateFields: updateFields,
      sqlQuery: `UPDATE oe.CommissionRules SET ${updateFields.join(', ')}, ModifiedDate = GETUTCDATE(), ModifiedBy = @ModifiedBy WHERE RuleId = @RuleId`
    });
    
    await request.query(`
      UPDATE oe.CommissionRules 
      SET ${updateFields.join(', ')}, 
          ModifiedDate = GETUTCDATE(),
          ModifiedBy = @ModifiedBy
      WHERE RuleId = @RuleId
    `);
    
    console.log('🔒 [UPDATE-RULE] Update completed successfully');
    
    logger.info('Commission rule updated', { 
      ruleId, 
      ruleName: rule.RuleName,
      updatedFields: updateFields,
      modifiedBy: req.user.UserId 
    }, 'Commission');
    
    res.json({
      success: true,
      message: 'Commission rule updated successfully'
    });
    
  } catch (error) {
    logger.error('Error updating commission rule', { error: error.message, user: req.user.UserId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update commission rule' 
    });
  }
});

/**
 * @route GET /api/commissions/rules/:ruleId/agents
 * @desc Get agents tied to a commission rule
 * @access TenantAdmin (own tenant rules only), SysAdmin
 */
router.get('/rules/:ruleId/agents', authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { ruleId } = req.params;
    const pool = await getPool();
    
    // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
    const tenantId = req.tenantId || req.user?.TenantId;
    
    // First check if rule exists and get its tenant
    const checkRequest = pool.request();
    checkRequest.input('RuleId', sql.UniqueIdentifier, ruleId);
    
    const checkResult = await checkRequest.query(`
      SELECT TenantId, RuleName, Locked 
      FROM oe.CommissionRules 
      WHERE RuleId = @RuleId AND Status != 'Deleted'
    `);
    
    if (checkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Commission rule not found'
      });
    }
    
    const rule = checkResult.recordset[0];
    
    // Check permissions with multi-tenant support
    if (getUserRoles(req.user).includes('TenantAdmin')) {
      // TenantAdmin can only access their own tenant's rules
      if (rule.TenantId !== tenantId) {
        return res.status(403).json({
          success: false,
          message: 'You can only access rules for your own tenant'
        });
      }
      // TenantAdmin cannot access global rules
      if (rule.TenantId === null) {
        return res.status(403).json({
          success: false,
          message: 'You cannot access global commission rules'
        });
      }
    }
    
    // Get agents tied to this commission rule
    // This includes:
    // 1. Agents with this rule explicitly assigned (CommissionRuleId = @RuleId)
    // 2. Agents without a rule assigned (CommissionRuleId IS NULL) if this is a default "all agents" rule
    //    (EntityType = 'Agent' AND EntityId IS NULL)
    const agentsRequest = pool.request();
    agentsRequest.input('RuleId', sql.UniqueIdentifier, ruleId);
    agentsRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
    
    // First, get the rule details to check if it's a default "all agents" rule
    const ruleDetailsRequest = pool.request();
    ruleDetailsRequest.input('RuleId', sql.UniqueIdentifier, ruleId);
    const ruleDetailsResult = await ruleDetailsRequest.query(`
      SELECT EntityType, agentid
      FROM oe.CommissionRules
      WHERE RuleId = @RuleId
    `);
    
    const isDefaultAllAgentsRule = ruleDetailsResult.recordset.length > 0 &&
      ruleDetailsResult.recordset[0].EntityType === 'Agent' &&
      ruleDetailsResult.recordset[0].agentid == null;
    
    let agentsQuery = `
      SELECT 
        a.AgentId,
        a.Name as AgentName,
        a.Email,
        a.Status
      FROM oe.Agents a
      WHERE a.TenantId = @TenantId
        AND a.Status = 'Active'
        AND (
          a.CommissionRuleId = @RuleId
    `;
    
    if (isDefaultAllAgentsRule) {
      agentsQuery += `
          OR a.CommissionRuleId IS NULL
      `;
    }
    
    agentsQuery += `
        )
      ORDER BY a.Name
    `;
    
    const agentsResult = await agentsRequest.query(agentsQuery);
    
    res.json({
      success: true,
      data: agentsResult.recordset,
      count: agentsResult.recordset.length
    });
    
  } catch (error) {
    logger.error('Error getting agents for commission rule', { error: error.message, user: req.user.UserId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to get agents for commission rule' 
    });
  }
});

/**
 * @route GET /api/commissions/rules/:ruleId/usage-check
 * @desc Check if a commission rule is in use (in oe.Commissions or oe.Agents)
 * @access TenantAdmin (own tenant rules only), SysAdmin
 */
router.get('/rules/:ruleId/usage-check', authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { ruleId } = req.params;
    const pool = await getPool();
    
    // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
    const tenantId = req.tenantId || req.user?.TenantId;
    
    // First check if rule exists and get its tenant
    const checkRequest = pool.request();
    checkRequest.input('RuleId', sql.UniqueIdentifier, ruleId);
    
    const checkResult = await checkRequest.query(`
      SELECT TenantId, RuleName, Locked 
      FROM oe.CommissionRules 
      WHERE RuleId = @RuleId AND Status != 'Deleted'
    `);
    
    if (checkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Commission rule not found'
      });
    }
    
    const rule = checkResult.recordset[0];
    
    // Check permissions with multi-tenant support
    if (getUserRoles(req.user).includes('TenantAdmin')) {
      // TenantAdmin can only access their own tenant's rules
      if (rule.TenantId !== tenantId) {
        return res.status(403).json({
          success: false,
          message: 'You can only access rules for your own tenant'
        });
      }
      // TenantAdmin cannot access global rules
      if (rule.TenantId === null) {
        return res.status(403).json({
          success: false,
          message: 'You cannot access global commission rules'
        });
      }
    }
    
    // Check if rule is used in oe.Agents
    const agentsRequest = pool.request();
    agentsRequest.input('RuleId', sql.UniqueIdentifier, ruleId);
    agentsRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
    
    const agentsResult = await agentsRequest.query(`
      SELECT COUNT(*) as AgentCount
      FROM oe.Agents
      WHERE CommissionRuleId = @RuleId
        AND TenantId = @TenantId
        AND Status = 'Active'
    `);
    
    const agentCount = agentsResult.recordset[0]?.AgentCount || 0;
    
    // Check if rule is used in oe.Commissions (check RuleIds JSON array)
    const commissionsRequest = pool.request();
    commissionsRequest.input('RuleId', sql.UniqueIdentifier, ruleId);
    commissionsRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
    
    const commissionsResult = await commissionsRequest.query(`
      SELECT COUNT(*) as CommissionCount
      FROM oe.Commissions c
      LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
      LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
      WHERE COALESCE(a.TenantId, ag.TenantId) = @TenantId
        AND c.RuleIds IS NOT NULL
        AND c.RuleIds != ''
        AND c.RuleIds != '[]'
        AND EXISTS (
          SELECT 1
          FROM OPENJSON(c.RuleIds) WITH (RuleId uniqueidentifier '$')
          WHERE RuleId = @RuleId
        )
    `);
    
    const commissionCount = commissionsResult.recordset[0]?.CommissionCount || 0;
    
    const isInUse = agentCount > 0 || commissionCount > 0;
    
    res.json({
      success: true,
      isInUse,
      agentCount,
      commissionCount,
      canUnlock: !isInUse
    });
    
  } catch (error) {
    logger.error('Error checking rule usage', { error: error.message, user: req.user.UserId, ruleId: req.params.ruleId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to check rule usage' 
    });
  }
});

/**
 * @route PUT /api/commissions/rules/:ruleId/unlock
 * @desc Unlock a commission rule (only if not in use)
 * @access TenantAdmin (own tenant rules only), SysAdmin
 */
router.put('/rules/:ruleId/unlock', authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { ruleId } = req.params;
    const pool = await getPool();
    
    // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
    const tenantId = req.tenantId || req.user?.TenantId;
    
    // First check if rule exists and get its tenant
    const checkRequest = pool.request();
    checkRequest.input('RuleId', sql.UniqueIdentifier, ruleId);
    
    const checkResult = await checkRequest.query(`
      SELECT TenantId, RuleName, Locked 
      FROM oe.CommissionRules 
      WHERE RuleId = @RuleId AND Status != 'Deleted'
    `);
    
    if (checkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Commission rule not found'
      });
    }
    
    const rule = checkResult.recordset[0];
    
    // Check permissions with multi-tenant support
    if (getUserRoles(req.user).includes('TenantAdmin')) {
      // TenantAdmin can only access their own tenant's rules
      if (rule.TenantId !== tenantId) {
        return res.status(403).json({
          success: false,
          message: 'You can only access rules for your own tenant'
        });
      }
      // TenantAdmin cannot access global rules
      if (rule.TenantId === null) {
        return res.status(403).json({
          success: false,
          message: 'You cannot access global commission rules'
        });
      }
    }
    
    // Check if rule is already unlocked
    if (!rule.Locked) {
      return res.status(400).json({
        success: false,
        message: 'Rule is already unlocked'
      });
    }
    
    // Check if rule is in use
    const agentsRequest = pool.request();
    agentsRequest.input('RuleId', sql.UniqueIdentifier, ruleId);
    agentsRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
    
    const agentsResult = await agentsRequest.query(`
      SELECT COUNT(*) as AgentCount
      FROM oe.Agents
      WHERE CommissionRuleId = @RuleId
        AND TenantId = @TenantId
        AND Status = 'Active'
    `);
    
    const agentCount = agentsResult.recordset[0]?.AgentCount || 0;
    
    // Check if rule is used in oe.Commissions
    const commissionsRequest = pool.request();
    commissionsRequest.input('RuleId', sql.UniqueIdentifier, ruleId);
    commissionsRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
    
    const commissionsResult = await commissionsRequest.query(`
      SELECT COUNT(*) as CommissionCount
      FROM oe.Commissions c
      LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
      LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
      WHERE COALESCE(a.TenantId, ag.TenantId) = @TenantId
        AND c.RuleIds IS NOT NULL
        AND c.RuleIds != ''
        AND c.RuleIds != '[]'
        AND EXISTS (
          SELECT 1
          FROM OPENJSON(c.RuleIds) WITH (RuleId uniqueidentifier '$')
          WHERE RuleId = @RuleId
        )
    `);
    
    const commissionCount = commissionsResult.recordset[0]?.CommissionCount || 0;
    
    if (agentCount > 0 || commissionCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot unlock rule: it is currently in use (${agentCount} agent(s) assigned, ${commissionCount} commission(s) recorded)`,
        agentCount,
        commissionCount
      });
    }
    
    // Unlock the rule
    const unlockRequest = pool.request();
    unlockRequest.input('RuleId', sql.UniqueIdentifier, ruleId);
    unlockRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
    
    await unlockRequest.query(`
      UPDATE oe.CommissionRules
      SET Locked = 0,
          ModifiedDate = GETUTCDATE(),
          ModifiedBy = @ModifiedBy
      WHERE RuleId = @RuleId
    `);
    
    logger.info('Commission rule unlocked', { 
      ruleId, 
      ruleName: rule.RuleName,
      unlockedBy: req.user.UserId 
    }, 'Commission');
    
    res.json({
      success: true,
      message: 'Rule unlocked successfully'
    });
    
  } catch (error) {
    logger.error('Error unlocking commission rule', { error: error.message, user: req.user.UserId, ruleId: req.params.ruleId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to unlock rule' 
    });
  }
});

/**
 * @route DELETE /api/commissions/rules/:ruleId
 * @desc Delete commission rule (soft delete with tenant permission check)
 * @access TenantAdmin (own tenant rules only), SysAdmin
 */
router.delete('/rules/:ruleId', authorize(['TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { ruleId } = req.params;
    const { newCommissionRuleId } = req.body; // Optional: new rule to migrate agents to
    const pool = await getPool();
    
    // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
    const tenantId = req.tenantId || req.user?.TenantId;
    
    // First check if rule exists and get its tenant
    const checkRequest = pool.request();
    checkRequest.input('RuleId', sql.UniqueIdentifier, ruleId);
    
    const checkResult = await checkRequest.query(`
      SELECT TenantId, RuleName, Locked 
      FROM oe.CommissionRules 
      WHERE RuleId = @RuleId AND Status != 'Deleted'
    `);
    
    if (checkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Commission rule not found'
      });
    }
    
    const rule = checkResult.recordset[0];
    
    // Check if rule is locked - locked rules cannot be deleted
    if (rule.Locked === true || rule.Locked === 1) {
      return res.status(403).json({
        success: false,
        message: 'This commission rule is locked and cannot be deleted. Only unlocked rules can be deleted.'
      });
    }
    
    // Check permissions with multi-tenant support
    if (getUserRoles(req.user).includes('TenantAdmin')) {
      // TenantAdmin can only delete their own tenant's rules
      if (rule.TenantId !== tenantId) {
        return res.status(403).json({
          success: false,
          message: 'You can only delete rules for your own tenant'
        });
      }
      // TenantAdmin cannot delete global rules
      if (rule.TenantId === null) {
        return res.status(403).json({
          success: false,
          message: 'You cannot delete global commission rules'
        });
      }
    }
    
    // Check if agents are tied to this rule
    const agentsCheckRequest = pool.request();
    agentsCheckRequest.input('RuleId', sql.UniqueIdentifier, ruleId);
    agentsCheckRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
    
    const agentsCheckResult = await agentsCheckRequest.query(`
      SELECT COUNT(*) as AgentCount
      FROM oe.Agents
      WHERE CommissionRuleId = @RuleId
        AND TenantId = @TenantId
        AND Status = 'Active'
    `);
    
    const agentCount = agentsCheckResult.recordset[0]?.AgentCount || 0;
    
    // If agents are tied and no new rule provided, return error
    if (agentCount > 0 && !newCommissionRuleId) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete commission rule. ${agentCount} agent(s) are currently assigned to this rule. Please select a new commission rule to assign them to.`,
        agentCount: agentCount,
        requiresMigration: true
      });
    }
    
    // If new rule provided, validate it and migrate agents
    if (newCommissionRuleId && agentCount > 0) {
      // Validate new rule exists and belongs to same tenant
      const newRuleCheckRequest = pool.request();
      newRuleCheckRequest.input('NewRuleId', sql.UniqueIdentifier, newCommissionRuleId);
      newRuleCheckRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
      
      const newRuleCheckResult = await newRuleCheckRequest.query(`
        SELECT RuleId, RuleName, Status, Locked
        FROM oe.CommissionRules
        WHERE RuleId = @NewRuleId
          AND (TenantId = @TenantId OR TenantId IS NULL)
          AND Status != 'Deleted'
      `);
      
      if (newRuleCheckResult.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'New commission rule not found or does not belong to your tenant'
        });
      }
      
      const newRule = newRuleCheckResult.recordset[0];
      
      // Don't allow migration to locked rules
      if (newRule.Locked === true || newRule.Locked === 1) {
        return res.status(400).json({
          success: false,
          message: 'Cannot migrate agents to a locked commission rule'
        });
      }
      
      // Migrate agents to new rule
      const migrateRequest = pool.request();
      migrateRequest.input('OldRuleId', sql.UniqueIdentifier, ruleId);
      migrateRequest.input('NewRuleId', sql.UniqueIdentifier, newCommissionRuleId);
      migrateRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
      migrateRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
      
      await migrateRequest.query(`
        UPDATE oe.Agents
        SET CommissionRuleId = @NewRuleId,
            ModifiedDate = GETUTCDATE(),
            ModifiedBy = @ModifiedBy
        WHERE CommissionRuleId = @OldRuleId
          AND TenantId = @TenantId
          AND Status = 'Active'
      `);
      
      logger.info('Agents migrated to new commission rule', { 
        oldRuleId: ruleId,
        newRuleId: newCommissionRuleId,
        agentCount: agentCount,
        migratedBy: req.user.UserId 
      }, 'Commission');
    }
    
    // Delete the rule (soft delete)
    const deleteRequest = pool.request();
    deleteRequest.input('RuleId', sql.UniqueIdentifier, ruleId);
    deleteRequest.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
    
    await deleteRequest.query(`
      UPDATE oe.CommissionRules 
      SET Status = 'Deleted',
          Locked = 0,
          ModifiedDate = GETUTCDATE(),
          ModifiedBy = @ModifiedBy
      WHERE RuleId = @RuleId
    `);
    
    logger.info('Commission rule deleted', { 
      ruleId,
      ruleName: rule.RuleName,
      deletedBy: req.user.UserId,
      agentsMigrated: agentCount > 0 ? agentCount : 0,
      migratedTo: newCommissionRuleId || null
    }, 'Commission');
    
    res.json({
      success: true,
      message: agentCount > 0 
        ? `Commission rule deleted successfully. ${agentCount} agent(s) migrated to new rule.`
        : 'Commission rule deleted successfully'
    });
    
  } catch (error) {
    logger.error('Error deleting commission rule', { error: error.message, user: req.user.UserId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete commission rule' 
    });
  }
});

/**
 * @route GET /api/commissions/agents/:agentId/downline
 * @desc Get agent's downline structure
 * @access Agent (own), Agency, TenantAdmin, SysAdmin
 */
router.get('/agents/:agentId/downline', async (req, res) => {
  try {
    const { agentId } = req.params;
    
    // Check authorization
    if (getUserRoles(req.user).includes('Agent') && req.user.AgentId !== agentId) {
      return res.status(403).json({ 
        success: false, 
        message: 'Unauthorized to view this downline' 
      });
    }
    
    const pool = await getPool();
    const request = pool.request();
    
    request.input('AgentId', sql.UniqueIdentifier, agentId);
    
    const result = await request.query(`
      WITH AgentHierarchy AS (
        -- Start with the requested agent
        SELECT 
          ah.AgentId,
          ah.ParentId,
          ah.ParentType,
          ah.TierLevel,
          ah.OverridePercentage,
          u.FirstName + ' ' + u.LastName as AgentName,
          u.Email,
          0 as Level
        FROM oe.AgentHierarchy ah
        JOIN oe.Users u ON ah.AgentId = u.UserId
        WHERE ah.AgentId = @AgentId
        
        UNION ALL
        
        -- Recursively get downline
        SELECT 
          ah.AgentId,
          ah.ParentId,
          ah.ParentType,
          ah.TierLevel,
          ah.OverridePercentage,
          u.FirstName + ' ' + u.LastName as AgentName,
          u.Email,
          h.Level + 1
        FROM oe.AgentHierarchy ah
        JOIN oe.Users u ON ah.AgentId = u.UserId
        JOIN AgentHierarchy h ON ah.ParentId = h.AgentId
        WHERE h.Level < 10  -- Prevent infinite recursion
      )
      SELECT 
        AgentId,
        ParentId,
        ParentType,
        TierLevel,
        OverridePercentage,
        AgentName,
        Email,
        Level
      FROM AgentHierarchy
      ORDER BY Level, AgentName
    `);
    
    res.json({
      success: true,
      downline: result.recordset
    });
    
  } catch (error) {
    logger.error('Error fetching agent downline', { error: error.message, agentId }, 'Commission');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch agent downline' 
    });
  }
});

/**
 * @route GET /api/commissions/notify-agents-preview
 * @desc Render the "agent commission generated" email template in HTML using the
 *       caller's tenant branding + a placeholder first name, so admins can
 *       eyeball it before checking the Notify Agents box.
 * @access SysAdmin, TenantAdmin (tenant-scoped)
 */
router.get('/notify-agents-preview', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'TenantId not found' });
    }
    const pool = await getPool();
    const cfg = await EmailTemplatesService.getTenantEmailConfig(tenantId).catch(() => null);
    const tReq = pool.request();
    tReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    const tRes = await tReq.query(`
      SELECT TenantId, Name, CustomLogoUrl, CustomDomain, DefaultUrlPath,
             IsDefaultUrlPathVerified, AdvancedSettings, SupportEmail, ContactEmail
      FROM oe.Tenants WHERE TenantId = @TenantId
    `);
    const tenantRow = tRes.recordset[0] || null;
    const tenantName = cfg?.tenantName || tenantRow?.Name || 'Your portal';
    const logoUrl = cfg?.logoUrl || tenantRow?.CustomLogoUrl || '';
    const supportEmail = cfg?.supportEmail || tenantRow?.SupportEmail || tenantRow?.ContactEmail || '';
    const portalUrl = `${tenantRow ? buildTenantAppBaseUrl(tenantRow) : 'https://app.allaboard365.com'}/agent/commissions`;
    const firstName = req.query?.firstName ? String(req.query.firstName) : 'Sample Agent';

    const templateRaw = EmailTemplatesService.loadTemplate('agent-commission-generated');
    const html = EmailTemplatesService.processTemplate(templateRaw, {
      firstName,
      tenantName,
      logoUrl,
      portalUrl,
      supportEmail
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    logger.warn('Failed to render notify-agents-preview', { error: err.message }, 'Commission');
    res.status(500).send('Failed to render preview');
  }
});

/**
 * @route POST /api/commissions/generate-missing
 * @desc Generate commissions for payments that don't have them
 * @access SysAdmin, TenantAdmin (tenant-scoped)
 * @note Uses same logic as CommissionTrigger (CommissionService.createCommissionsForPayment)
 */
router.post('/generate-missing', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  req.setTimeout(900000); // 15 minutes — commission generation can be slow for large batches
  try {
    const { limit, dryRun, startDate, endDate, notifyAgents, paymentIds } = req.body;
    const pool = await getPool();
    const userRoles = getUserRoles(req.user);
    const isTenantAdmin = userRoles.includes('TenantAdmin');
    let tenantFilterClause = '';
    const requestObj = pool.request();
    if (isTenantAdmin) {
      const tenantId = req.tenantId || req.user?.TenantId;
      if (!tenantId) {
        return res.status(400).json({ success: false, message: 'TenantId not found for TenantAdmin' });
      }
      requestObj.input('TenantId', sql.UniqueIdentifier, tenantId);
      tenantFilterClause = ' AND a.TenantId = @TenantId';
    }

    let dateFilterClause = '';
    if (startDate && endDate) {
      requestObj.input('StartDate', sql.Date, startDate);
      requestObj.input('EndDate', sql.Date, endDate);
      dateFilterClause = ' AND CAST(p.PaymentDate AS DATE) >= @StartDate AND CAST(p.PaymentDate AS DATE) <= @EndDate';
    }

    const paymentIdsClause = buildPaymentIdsInClause(paymentIds);
    if (Array.isArray(paymentIds) && paymentIds.length > 0 && paymentIdsClause.includes('1=0')) {
      return res.status(400).json({ success: false, message: 'No valid paymentIds provided' });
    }

    // Find payments without commissions
    let limitClause = '';
    if (limit && typeof limit === 'number' && limit > 0) {
      limitClause = `TOP ${limit}`;
    }

    let query = `
      SELECT ${limitClause}
        p.PaymentId,
        p.HouseholdId,
        p.GroupId,
        p.PaymentDate,
        p.EnrollmentId,
        p.Amount,
        p.AgentId,
        p.Status,
        -- Invoice-sourced payouts: prefer invoice breakdowns with payment fallback
        COALESCE(inv.Commission, p.Commission) AS Commission,
        COALESCE(inv.OverrideRate, p.OverrideRate) AS OverrideRate,
        COALESCE(inv.NetRate, p.NetRate) AS NetRate,
        e.ProductId
      FROM oe.Payments p
      INNER JOIN oe.Agents a ON p.AgentId = a.AgentId
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId AND e.Status = 'Active'
      LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
      WHERE p.Status IN ('Completed', 'Draft', 'APPROVAL', 'SUCCESS', 'COMPLETED', 'succeeded')
        AND p.AgentId IS NOT NULL
        AND COALESCE(inv.Commission, p.Commission) IS NOT NULL
        AND COALESCE(inv.Commission, p.Commission) > 0
        AND a.Status = 'Active'
        AND NOT EXISTS (
          SELECT 1
          FROM oe.Commissions c
          WHERE c.Status != 'Deleted'
            AND (
              c.PaymentId = p.PaymentId
              OR (p.InvoiceId IS NOT NULL AND c.InvoiceId = p.InvoiceId)
              OR EXISTS (
                SELECT 1 FROM oe.Payments pLink
                WHERE pLink.InvoiceId = p.InvoiceId
                  AND pLink.PaymentId = c.PaymentId
              )
            )
        )
        ${tenantFilterClause}
        ${dateFilterClause}
        ${paymentIdsClause}
      ORDER BY p.PaymentDate ASC
    `;

    const result = await requestObj.query(query);
    const payments = result.recordset;

    if (payments.length === 0) {
      return res.json({
        success: true,
        processed: 0,
        created: 0,
        failed: 0,
        message: Array.isArray(paymentIds) && paymentIds.length > 0
          ? 'No selected invoices found without commissions'
          : 'No invoices found without commissions'
      });
    }

    if (dryRun === true) {
      const dryRunPreview = [];
      for (const payment of payments) {
        const commissionStatus = payment.Status === 'Draft' ? 'Draft' : 'Pending';
        try {
          const result = await CommissionServiceAdvances.createCommissionsForPayment({
            paymentId: payment.PaymentId,
            householdId: payment.GroupId ? null : payment.HouseholdId,
            groupId: payment.GroupId,
            paymentDate: payment.PaymentDate,
            // oe.Payments.EnrollmentId is deprecated — commissions use HouseholdId / GroupId only.
            enrollmentId: null,
            productId: null,
            paymentAmount: parseFloat(payment.Amount),
            agentId: payment.AgentId,
            tenantId: null,
            commission: payment.Commission !== null ? parseFloat(payment.Commission) : null,
            overrideRate: payment.OverrideRate != null ? parseFloat(payment.OverrideRate) : 0,
            netRate: payment.NetRate != null ? parseFloat(payment.NetRate) : null,
            commissionStatus,
            dryRun: true
          });
          const rows = result.dryRunRows || [];
          dryRunPreview.push(...rows);
        } catch (err) {
          dryRunPreview.push({
            paymentId: payment.PaymentId,
            error: err.message || 'Unknown error',
            _previewError: true
          });
        }
      }

      // Enrich dry run rows with agent/agency names
      const validRows = dryRunPreview.filter(r => !r._previewError);
      const agentIds = [...new Set(validRows.map(r => r.agentId).filter(Boolean))];
      const agencyIds = [...new Set(validRows.map(r => r.agencyId).filter(Boolean))];
      const agentNameMap = new Map();
      const agencyNameMap = new Map();
      if (agentIds.length > 0) {
        const agentIdsList = agentIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(',');
        const agentNamesResult = await pool.request().query(`
          SELECT a.AgentId, u.FirstName + ' ' + u.LastName AS AgentName
          FROM oe.Agents a
          INNER JOIN oe.Users u ON a.UserId = u.UserId
          WHERE a.AgentId IN (${agentIdsList})
        `);
        (agentNamesResult.recordset || []).forEach(r => {
          agentNameMap.set(r.AgentId?.toString(), r.AgentName || 'Unknown agent');
        });
      }
      if (agencyIds.length > 0) {
        const agencyIdsList = agencyIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(',');
        const agencyNamesResult = await pool.request().query(`
          SELECT AgencyId, AgencyName
          FROM oe.Agencies
          WHERE AgencyId IN (${agencyIdsList})
        `);
        (agencyNamesResult.recordset || []).forEach(r => {
          agencyNameMap.set(r.AgencyId?.toString(), r.AgencyName || 'Unknown agency');
        });
      }
      dryRunPreview.forEach((row) => {
        if (row._previewError) return;
        const agentIdStr = row.agentId != null ? String(row.agentId) : null;
        const agencyIdStr = row.agencyId != null ? String(row.agencyId) : null;
        const agentName = agentIdStr ? agentNameMap.get(agentIdStr) : null;
        const agencyName = agencyIdStr ? agencyNameMap.get(agencyIdStr) : null;
        row.recipientName = agentName || agencyName || '—';
      });

      return res.json({
        success: true,
        processed: payments.length,
        wouldCreate: validRows.length,
        dryRunPreview,
        message: `Would create ${validRows.length} commission row(s) for ${payments.length} payment(s)`
      });
    }

    // Process all payments in a single transaction — all or nothing.
    let created = 0;
    const createdCommissionsReport = []; // { paymentId, commissionIds: [] }
    const allCommissionIds = [];
    let failedPaymentId = null;

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      for (const payment of payments) {
        failedPaymentId = payment.PaymentId;
        const commissionStatus = payment.Status === 'Draft' ? 'Draft' : 'Pending';

        // Defensive: drop any stale AGENT_OVERRIDE:* rows for this payment so override
        // application starts from a clean slate inside the transaction.
        try {
          const cleanupReq = new sql.Request(transaction);
          cleanupReq.input('PaymentId', sql.UniqueIdentifier, payment.PaymentId);
          await cleanupReq.query(`
            UPDATE oe.Commissions
            SET Status = 'Deleted', ModifiedDate = GETUTCDATE()
            WHERE PaymentId = @PaymentId
              AND Status <> 'Deleted'
              AND RuleIds LIKE 'AGENT_OVERRIDE:%'
          `);
        } catch (cleanupErr) {
          logger.warn('Failed to soft-delete stale agent override rows (continuing)', {
            paymentId: payment.PaymentId,
            error: cleanupErr.message
          }, 'Commission');
        }

        const result = await CommissionServiceAdvances.createCommissionsForPayment({
          paymentId: payment.PaymentId,
          householdId: payment.GroupId ? null : payment.HouseholdId,
          groupId: payment.GroupId,
          paymentDate: payment.PaymentDate,
          enrollmentId: null,
          productId: null,
          paymentAmount: parseFloat(payment.Amount),
          agentId: payment.AgentId,
          tenantId: null,
          commission: payment.Commission !== null ? parseFloat(payment.Commission) : null,
          overrideRate: payment.OverrideRate !== null ? parseFloat(payment.OverrideRate) : 0,
          netRate: payment.NetRate !== null ? parseFloat(payment.NetRate) : null,
          commissionStatus,
          transaction
        });

        created += result.commissionsCreated || 0;
        const ids = result.commissionIds || [];
        if (ids.length > 0) {
          createdCommissionsReport.push({ paymentId: payment.PaymentId, commissionIds: ids });
          allCommissionIds.push(...ids);
        }

        logger.info(`Commissions created for payment ${payment.PaymentId}`, {
          paymentId: payment.PaymentId,
          commissionsCreated: result.commissionsCreated,
          status: commissionStatus,
          generatedBy: req.user?.UserId
        }, 'Commission');
      }

      await transaction.commit();

      logger.info('Missing commissions generation completed', {
        processed: payments.length,
        created,
        generatedBy: req.user?.UserId
      }, 'Commission');

      // Notify-agents fan-out — only after a successful commit. One bulk-batch
      // job per tenant (not per agent). The Message Center worker fans out to
      // SendGrid in 100-recipient batches and writes oe.MessageHistory rows
      // per recipient, so the Communications tab still surfaces each send
      // and we don't clog oe.MessageQueue with 500+ rows on big runs.
      let notificationsQueued = 0;
      if (notifyAgents === true && allCommissionIds.length > 0) {
        try {
          const recipientPool = await getPool();
          const idParams = allCommissionIds.map((_, i) => `@C${i}`).join(', ');
          const recipReq = recipientPool.request();
          allCommissionIds.forEach((id, i) => {
            recipReq.input(`C${i}`, sql.UniqueIdentifier, id);
          });

          // Only notify agents whose new commissions will actually land in the
          // payout for the SAME date window the admin selected. Commission rows
          // are created on a *payment-date* window, but NACHA pays on the
          // *invoice due-date* window (COALESCE(DueDate, BillingPeriodStart,
          // PaymentDate)). A payment made in advance of a future invoice (e.g.
          // a May payment for a June invoice) creates the row now but pays in a
          // later cycle — emailing "payout generated" then is a false alarm.
          // Mirror the getEligibleCommissions positive-row windows here so the
          // notify set matches what the NACHA for [StartDate, EndDate] pays.
          let payoutEligibilityClause = '';
          if (startDate && endDate) {
            recipReq.input('StartDate', sql.Date, startDate);
            recipReq.input('EndDate', sql.Date, endDate);
            payoutEligibilityClause = `
              AND (
                -- Payment-anchored rows: due-date window (PaymentDate when no invoice).
                (c.PaymentId IS NOT NULL AND ${agentCommissionDueWindowSql()})
                -- Credit-funded invoice-anchored rows: invoice due-date window.
                OR (c.PaymentId IS NULL AND c.InvoiceId IS NOT NULL
                    AND inv.Status = N'Paid'
                    AND ${agentCommissionCreditBranchWindowSql('inv')})
              )
            `;
          }

          const recipRes = await recipReq.query(`
            SELECT DISTINCT a.AgentId, a.TenantId, u.UserId, u.Email
            FROM oe.Commissions c
            INNER JOIN oe.Agents a ON c.AgentId = a.AgentId
            INNER JOIN oe.Users u ON a.UserId = u.UserId
            LEFT JOIN oe.Payments p ON p.PaymentId = c.PaymentId
            LEFT JOIN oe.Invoices inv ON inv.InvoiceId = COALESCE(p.InvoiceId, c.InvoiceId)
            WHERE c.CommissionId IN (${idParams})
              AND c.AgentId IS NOT NULL
              AND a.Status = 'Active'
              AND u.Email IS NOT NULL
              ${payoutEligibilityClause}
          `);

          // Group recipients by tenant — SysAdmin runs can span multiple tenants
          // and each tenant has its own branding / from-address.
          const byTenant = new Map();
          for (const row of (recipRes.recordset || [])) {
            const tenantId = row.TenantId?.toString();
            if (!tenantId || !row.Email) continue;
            if (!byTenant.has(tenantId)) byTenant.set(tenantId, new Set());
            byTenant.get(tenantId).add(String(row.Email).trim());
          }

          const templateRaw = EmailTemplatesService.loadTemplate('agent-commission-generated');

          for (const [tenantId, emailSet] of byTenant) {
            try {
              const emails = Array.from(emailSet);
              if (emails.length === 0) continue;

              const cfg = await EmailTemplatesService.getTenantEmailConfig(tenantId).catch(() => null);
              const tReq = recipientPool.request();
              tReq.input('TenantId', sql.UniqueIdentifier, tenantId);
              const tRes = await tReq.query(`
                SELECT TenantId, Name, CustomLogoUrl, CustomDomain, DefaultUrlPath,
                       IsDefaultUrlPathVerified, AdvancedSettings, SupportEmail, ContactEmail
                FROM oe.Tenants WHERE TenantId = @TenantId
              `);
              const tenantRow = tRes.recordset[0] || null;
              const tenantName = cfg?.tenantName || tenantRow?.Name || 'Your portal';
              const logoUrl = cfg?.logoUrl || tenantRow?.CustomLogoUrl || '';
              const supportEmail = cfg?.supportEmail || tenantRow?.SupportEmail || tenantRow?.ContactEmail || '';
              const portalUrl = `${tenantRow ? buildTenantAppBaseUrl(tenantRow) : 'https://app.allaboard365.com'}/agent/commissions`;

              const html = EmailTemplatesService.processTemplate(templateRaw, {
                tenantName,
                logoUrl,
                portalUrl,
                supportEmail
              });

              // Insert MessageSendBatch parent (mirrors message-blast pattern).
              const sendBatchId = require('crypto').randomUUID();
              await recipientPool.request()
                .input('BatchId', sql.UniqueIdentifier, sendBatchId)
                .input('TenantId', sql.UniqueIdentifier, tenantId)
                .input('Label', sql.NVarChar, 'Commission notify')
                .input('SmsTotal', sql.Int, 0)
                .input('EmailTotal', sql.Int, emails.length)
                .input('CreatedBy', sql.UniqueIdentifier, req.user?.UserId || null)
                .query(`
                  INSERT INTO oe.MessageSendBatch (BatchId, TenantId, Label, SmsTotal, EmailTotal, CreatedDate, CreatedBy)
                  VALUES (@BatchId, @TenantId, @Label, @SmsTotal, @EmailTotal, GETUTCDATE(), @CreatedBy)
                `);

              await MessageQueueService.queueBulkBatchMessage({
                tenantId,
                batchId: sendBatchId,
                bodyPayload: {
                  v: 1,
                  batchId: sendBatchId,
                  tenantId,
                  sendEmail: true,
                  sendSMS: false,
                  subject: 'New commission payout generated',
                  emailBody: html,
                  smsBody: '',
                  emails,
                  phones: [],
                  createdBy: req.user?.UserId || null
                },
                createdBy: req.user?.UserId || null
              });

              notificationsQueued += emails.length;
            } catch (perTenantErr) {
              logger.warn('Failed to queue agent commission bulk batch for tenant', {
                tenantId,
                error: perTenantErr.message
              }, 'Commission');
            }
          }
        } catch (notifyErr) {
          // Best-effort — never fail the API response over notification issues.
          logger.warn('Agent commission notification fan-out failed', {
            error: notifyErr.message
          }, 'Commission');
        }
      }

      if (!res.headersSent) {
        res.json({
          success: true,
          processed: payments.length,
          created,
          failed: 0,
          createdCommissions: createdCommissionsReport,
          createdCommissionIds: allCommissionIds,
          notificationsQueued,
          message: `Generated ${created} commission row(s) for ${payments.length} payment(s)`
        });
      }
    } catch (txError) {
      try { await transaction.rollback(); } catch (_) { /* already rolled back */ }

      const errorMessage = txError.message || 'Unknown error';
      logger.error('Commission generation rolled back', {
        failedPaymentId,
        error: errorMessage,
        processedBeforeFailure: created,
        generatedBy: req.user?.UserId
      }, 'Commission');
      console.error(`❌ Commission generation rolled back at payment ${failedPaymentId}:`, txError);

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: `Generation rolled back — failed on payment ${failedPaymentId}: ${errorMessage}`,
          processedBeforeFailure: created,
          failedPayment: { paymentId: failedPaymentId, error: errorMessage }
        });
      }
      return;
    }

  } catch (error) {
    logger.error('Error generating missing commissions', { error: error.message, user: req.user?.UserId }, 'Commission');
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to generate missing commissions'
      });
    }
  }
});

/**
 * @route GET /api/commissions/topup-preview
 * @desc List paid invoices in range that already have commission rows (top-up candidates).
 *       Fast list only — no commission recalculation.
 * @access SysAdmin, TenantAdmin (tenant-scoped)
 */
router.get('/topup-preview', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'startDate and endDate are required.'
      });
    }

    const userRoles = getUserRoles(req.user);
    const isTenantAdmin = userRoles.includes('TenantAdmin');
    const tenantId = isTenantAdmin ? (req.tenantId || req.user?.TenantId) : null;
    if (isTenantAdmin && !tenantId) {
      return res.status(400).json({ success: false, message: 'TenantId not found for TenantAdmin' });
    }

    const items = await commissionTopupService.listTopupEligibleInvoices({
      startDate,
      endDate,
      tenantId
    });

    res.json({
      success: true,
      items,
      count: items.length,
      message: items.length === 0
        ? 'No paid invoices with existing commissions in this range.'
        : `${items.length} invoice(s) eligible for commission top-up`
    });
  } catch (error) {
    logger.error('Error fetching top-up preview list', { error: error.message, user: req.user?.UserId }, 'Commission');
    res.status(500).json({ success: false, message: 'Failed to load top-up invoice list' });
  }
});

/**
 * @route POST /api/commissions/generate-topup
 * @desc Generate top-up commission rows for selected paid invoices (invoice-anchored).
 * @access SysAdmin, TenantAdmin (tenant-scoped)
 */
router.post('/generate-topup', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  req.setTimeout(900000);
  try {
    const {
      invoiceIds,
      // Deprecated: payment-scoped top-up. Prefer invoiceIds.
      paymentIds,
      startDate,
      endDate,
      dryRun = true,
      limit
    } = req.body || {};

    const userRoles = getUserRoles(req.user);
    const isTenantAdmin = userRoles.includes('TenantAdmin');
    const tenantId = isTenantAdmin ? (req.tenantId || req.user?.TenantId) : null;
    if (isTenantAdmin && !tenantId) {
      return res.status(400).json({ success: false, message: 'TenantId not found for TenantAdmin' });
    }

    let resolvedInvoiceIds = Array.isArray(invoiceIds)
      ? invoiceIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];

    // Back-compat: map paymentIds → invoiceIds when explicit invoice list not provided.
    if (resolvedInvoiceIds.length === 0 && Array.isArray(paymentIds) && paymentIds.length > 0) {
      const pool = await getPool();
      const safeList = paymentIds.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(',');
      const mapResult = await pool.request().query(`
        SELECT DISTINCT inv.InvoiceId
        FROM oe.Payments p
        INNER JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
        WHERE p.PaymentId IN (${safeList})
      `);
      resolvedInvoiceIds = (mapResult.recordset || []).map((r) => r.InvoiceId.toString());
    }

    if (resolvedInvoiceIds.length === 0) {
      if (!(startDate && endDate)) {
        return res.status(400).json({
          success: false,
          message: 'Provide invoiceIds[] or startDate+endDate to select invoices for top-up.'
        });
      }
      const listed = await commissionTopupService.listTopupEligibleInvoices({
        startDate,
        endDate,
        tenantId
      });
      resolvedInvoiceIds = listed.map((row) => row.invoiceId);
    }

    if (limit && typeof limit === 'number' && limit > 0) {
      resolvedInvoiceIds = resolvedInvoiceIds.slice(0, limit);
    }

    if (resolvedInvoiceIds.length === 0) {
      return res.json({
        success: true,
        processed: 0,
        wouldCreate: 0,
        created: 0,
        topupPreview: [],
        message: 'No invoices matched top-up criteria.'
      });
    }

    const result = await commissionTopupService.applyTopupForInvoices({
      invoiceIds: resolvedInvoiceIds,
      dryRun: !!dryRun
    });

    const topupPreview = (result.topupPreview || []).filter((r) => !r._previewError);

    return res.json({
      success: true,
      dryRun: !!dryRun,
      processed: result.processed,
      wouldCreate: topupPreview.length,
      created: result.created,
      failed: 0,
      topupPreview,
      createdCommissions: result.createdCommissions?.length ? result.createdCommissions : undefined,
      message: dryRun
        ? `Top-up dry run complete. Would create ${topupPreview.length} commission row(s) across ${result.processed} invoice(s).`
        : `Top-up generation complete. Created ${result.created} commission row(s).`
    });
  } catch (error) {
    logger.error('Error generating top-up commissions', {
      error: error.message,
      failedInvoiceId: error.failedInvoiceId,
      user: req.user?.UserId
    }, 'Commission');
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: error.failedInvoiceId
          ? `Top-up failed on invoice ${error.failedInvoiceId}: ${error.message}`
          : (error.message || 'Failed to generate top-up commissions')
      });
    }
  }
});

/**
 * @route DELETE /api/commissions/reset
 * @desc Delete all commission records (SysAdmin only)
 * @access SysAdmin only
 * @note This is a destructive operation - use with caution
 */
router.delete('/reset', authorize(['SysAdmin']), async (req, res) => {
  console.log('🗑️ /api/commissions/reset route hit');
  console.log('Request body:', req.body);
  console.log('Request query:', req.query);
  try {
    const paymentId = req.query.paymentId || req.body?.paymentId; // DELETE requests use query params
    
    const pool = await getPool();
    const request = pool.request();
    request.timeout = 30000; // 30 second timeout
    
    let query;
    let deletedCount = 0;
    
    if (paymentId) {
      // Soft delete commissions for specific payment (set Status = 'Deleted')
      console.log(`Soft deleting commissions for payment: ${paymentId}`);
      request.input('PaymentId', sql.UniqueIdentifier, paymentId);
      query = `
        UPDATE oe.Commissions
        SET Status = 'Deleted',
            ModifiedDate = GETUTCDATE()
        WHERE PaymentId = @PaymentId
          AND Status != 'Deleted'
      `;
    } else {
      // Soft delete ALL commissions (set Status = 'Deleted')
      console.log('Soft deleting ALL commissions (setting Status = "Deleted")...');
      query = `
        UPDATE oe.Commissions
        SET Status = 'Deleted',
            ModifiedDate = GETUTCDATE()
        WHERE Status != 'Deleted'
      `;
    }
    
    // Execute query
    if (query) {
      console.log('Executing update query:', query);
      const result = await request.query(query);
      deletedCount = result.rowsAffected[0] || 0;
      console.log(`✅ Soft deleted ${deletedCount} commission record(s)`);
    }
    
    logger.info('Commissions reset (soft delete)', {
      deletedCount,
      paymentId: paymentId || 'all',
      deletedBy: req.user?.UserId
    }, 'Commission');
    
    console.log('✅ Commissions reset successful, sending response...');
    res.json({
      success: true,
      deletedCount,
      message: paymentId 
        ? `Soft deleted ${deletedCount} commission record(s) for payment ${paymentId}`
        : `Soft deleted ${deletedCount} commission record(s)`
    });
    
  } catch (error) {
    console.error('❌ Error resetting commissions:', error);
    logger.error('Error resetting commissions', { 
      error: error.message, 
      stack: error.stack,
      user: req.user?.UserId 
    }, 'Commission');
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to reset commissions'
    });
  }
});

module.exports = router;