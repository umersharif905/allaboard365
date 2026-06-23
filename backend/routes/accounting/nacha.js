// backend/routes/accounting/nacha.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const { authenticate, authorize, getUserRoles } = require('../../middleware/auth');
const requireTenantAccess = require('../../middleware/requireTenantAccess');
const nachaService = require('../../services/NACHAService');
const VendorExportService = require('../../services/vendorExportService');
const MessageQueueService = require('../../services/messageQueue.service');
const logger = require('../../config/logger');
const { getPool, sql } = require('../../config/database');
const clawbackBalances = require('../../services/clawbackBalances.service');
const PayoutClawbacks = require('../../services/payoutClawbacks.service');
const {
  PAID_PAYMENT_STATUSES_SQL,
  PAID_INVOICE_STATUS,
} = require('../../constants/paymentStatuses');
const {
  paymentInWindowSql,
  fundingGateSql,
  invoicePayoutWindowSql,
  agentCommissionDueWindowSql,
  agentCommissionClawbackWindowSql,
  staleVendorPayablesOutsideRangeSql,
  staleCommissionPayablesOutsideRangeSql,
  invoiceFulfillmentAnchorExprSql,
} = require('../../services/payoutFunding.service');

function vendorPayoutAnchorDateExprForSelect(vendorPayoutBasis) {
  if (vendorPayoutBasis === 'paymentReceived') {
    return invoiceFulfillmentAnchorExprSql('inv');
  }
  return `(CASE
    WHEN p.InvoiceId IS NOT NULL AND inv.BillingPeriodStart IS NOT NULL
    THEN inv.BillingPeriodStart
    ELSE p.PaymentDate
  END)`;
}

const COMMISSION_STALE_ANCHOR_DATE_EXPR_SQL = `CASE
  WHEN c.TransactionType IN ('Refund', 'Chargeback') THEN CAST(c.CreatedDate AS DATE)
  WHEN p.InvoiceId IS NULL THEN CAST(p.PaymentDate AS DATE)
  ELSE CAST(COALESCE(inv.DueDate, inv.BillingPeriodStart, p.PaymentDate) AS DATE)
END`;

/**
 * True when the payout source has no ProductCommissions snapshot.
 * Works for both payment-anchored rows and invoice-anchored / credit-funded rows
 * (where ProductCommissions is COALESCEd from oe.Invoices).
 *
 * For vendor/product-owner NACHA, missing ProductCommissions is a proxy signal
 * that per-product detail JSON wasn't snapshotted at funding time.
 */
function paymentMissingProductSnapshotJson(p) {
  if (!p) return true;
  const v = p.ProductCommissions;
  return v == null || (typeof v === 'string' && v.trim() === '');
}

/** Stable identifier for a payout source row (PaymentId or InvoiceId). */
function payoutSourceId(p) {
  if (!p) return null;
  return p.PaymentId || p.InvoiceId || null;
}

// All routes require authentication and SysAdmin or TenantAdmin role
router.use(authenticate);
router.use(authorize(['SysAdmin', 'TenantAdmin']));

/**
 * GET /api/accounting/nacha/commission-hold-settings
 * Returns commission hold settings + "safe" end date (today - hold window).
 * SysAdmin may provide tenantId query param; TenantAdmin is scoped to own tenant.
 */
router.get('/commission-hold-settings', async (req, res) => {
  try {
    const userRoles = getUserRoles(req.user);
    const isSysAdmin = userRoles.includes('SysAdmin');
    const requestedTenantId = req.query?.tenantId ? String(req.query.tenantId) : null;
    const effectiveTenantId = isSysAdmin
      ? (requestedTenantId || req.user?.TenantId || null)
      : (req.user?.TenantId || null);

    if (!effectiveTenantId) {
      return res.status(400).json({ success: false, message: 'TenantId is required' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('TenantId', sql.UniqueIdentifier, effectiveTenantId);
    const result = await request.query(`
      SELECT TenantId, Name, AdvancedSettings
      FROM oe.Tenants
      WHERE TenantId = @TenantId
    `);

    if (!result.recordset.length) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }

    const tenant = result.recordset[0];
    let advanced = {};
    try {
      advanced = tenant.AdvancedSettings
        ? (typeof tenant.AdvancedSettings === 'string' ? JSON.parse(tenant.AdvancedSettings) : tenant.AdvancedSettings)
        : {};
    } catch (e) {
      advanced = {};
    }

    const holdDaysRaw = advanced?.commissions?.holdDays;
    const holdDays = Number.isFinite(Number(holdDaysRaw)) ? Math.max(0, Number(holdDaysRaw)) : 0;
    const holdDaysCountFrom = advanced?.commissions?.holdDaysCountFrom === 'nextDay' ? 'nextDay' : 'paymentDate';
    const holdOffsetDays = holdDays + (holdDaysCountFrom === 'nextDay' ? 1 : 0);

    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const safeEndDateUtc = new Date(todayUtc);
    safeEndDateUtc.setUTCDate(safeEndDateUtc.getUTCDate() - holdOffsetDays);

    const toYmd = (d) => d.toISOString().slice(0, 10);

    return res.json({
      success: true,
      data: {
        tenantId: String(tenant.TenantId),
        tenantName: tenant.Name || null,
        holdDays,
        holdDaysCountFrom,
        holdOffsetDays,
        todayDate: toYmd(todayUtc),
        safeEndDate: toYmd(safeEndDateUtc)
      }
    });
  } catch (error) {
    logger.error('Error getting commission hold settings', { error: error.message }, 'NACHA');
    return res.status(500).json({ success: false, message: 'Failed to get commission hold settings' });
  }
});

/**
 * GET /api/accounting/nacha/stale-payables-summary
 * Fast COUNT-only hint: payables whose payout anchor falls in the trailing ~30d (to EndDate)
 * but outside the selected [startDate, endDate]. Mirrors vendor / override / commission anchors.
 *
 * Query: startDate, endDate, tenantId? (SysAdmin), trailingDays? (default 30),
 * includeVendor (default true), includeOverrides (default true), includeCommissions (default true),
 * includeDetails (default true) — when true, includes vendorStaleRows / overrideStaleRows / commissionStaleRows (capped),
 * detailLimit? (default 100, max 200).
 */
router.get('/stale-payables-summary', async (req, res) => {
  try {
    const { startDate, endDate } = req.query || {};
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'startDate and endDate are required' });
    }
    const userRoles = getUserRoles(req.user);
    const isSysAdmin = userRoles.includes('SysAdmin');
    const tenantId = isSysAdmin && req.query.tenantId
      ? String(req.query.tenantId)
      : (req.user?.TenantId || req.tenantId || null);
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'TenantId is required' });
    }

    const trailingDays = Math.min(120, Math.max(1, parseInt(String(req.query.trailingDays || '30'), 10) || 30));
    const incV = req.query.includeVendor !== 'false';
    const incO = req.query.includeOverrides !== 'false';
    const incC = req.query.includeCommissions !== 'false';

    const start = new Date(String(startDate));
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(String(endDate));
    end.setUTCHours(23, 59, 59, 999);

    const pool = await getPool();
    const tsReq = pool.request();
    tsReq.input('TId', sql.UniqueIdentifier, tenantId);
    const tsRes = await tsReq.query(
      'SELECT AdvancedSettings FROM oe.Tenants WHERE TenantId = @TId'
    );
    let vendorPayoutBasis = 'effectiveEnrollment';
    let overridePayoutBasis = 'paymentReceived';
    if (tsRes.recordset?.length) {
      const raw = tsRes.recordset[0].AdvancedSettings;
      const adv = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
      vendorPayoutBasis = adv?.payouts?.vendorBasis || 'effectiveEnrollment';
      overridePayoutBasis = adv?.payouts?.overrideBasis || 'paymentReceived';
    }

    const out = {
      trailingDays,
      vendorBasis: vendorPayoutBasis,
      overrideBasis: overridePayoutBasis,
      vendorStaleCount: 0,
      overrideStaleCount: 0,
      commissionStaleCount: 0,
    };

    const staleVendorFrag = staleVendorPayablesOutsideRangeSql({
      payoutBasis: vendorPayoutBasis,
    }).replace(/\s+/g, ' ');
    const staleOverrideFrag = staleVendorPayablesOutsideRangeSql({
      payoutBasis: overridePayoutBasis,
    }).replace(/\s+/g, ' ');
    const staleCommFrag = staleCommissionPayablesOutsideRangeSql().replace(/\s+/g, ' ');

    if (incV) {
      const r = await pool.request();
      r.input('StartDate', sql.DateTime2, start);
      r.input('EndDate', sql.DateTime2, end);
      r.input('TrailingDays', sql.Int, trailingDays);
      r.input('TenantId', sql.UniqueIdentifier, tenantId);
      const q = await r.query(`
        SELECT COUNT(*) AS Cnt FROM oe.Payments p
        LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
        WHERE p.TenantId = @TenantId
          AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
          AND ${fundingGateSql()}
          AND (${staleVendorFrag})
      `);
      out.vendorStaleCount = q.recordset[0]?.Cnt || 0;
    }

    if (incO) {
      const r = await pool.request();
      r.input('StartDate', sql.DateTime2, start);
      r.input('EndDate', sql.DateTime2, end);
      r.input('TrailingDays', sql.Int, trailingDays);
      r.input('TenantId', sql.UniqueIdentifier, tenantId);
      const q = await r.query(`
        SELECT COUNT(*) AS Cnt FROM oe.Payments p
        LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
        WHERE p.TenantId = @TenantId
          AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
          AND ${fundingGateSql()}
          AND (${staleOverrideFrag})
      `);
      out.overrideStaleCount = q.recordset[0]?.Cnt || 0;
    }

    if (incC) {
      const r = pool.request();
      r.input('StartDate', sql.DateTime2, start);
      r.input('EndDate', sql.DateTime2, end);
      r.input('TrailingDays', sql.Int, trailingDays);
      r.input('TenantId', sql.UniqueIdentifier, tenantId);
      const q = await r.query(`
        SELECT COUNT(*) AS Cnt
        FROM oe.Commissions c
        INNER JOIN oe.Payments p ON c.PaymentId = p.PaymentId
        LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
        LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
        LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
        WHERE c.Status = 'Pending'
          AND c.TransactionType IN ('Advance', 'Commission', 'Refund', 'Chargeback')
          AND c.Amount != 0
          AND COALESCE(a.TenantId, ag.TenantId) = @TenantId
          AND (
            (c.TransactionType IN ('Refund', 'Chargeback') AND p.PaymentId IS NOT NULL)
            OR (c.TransactionType NOT IN ('Refund', 'Chargeback')
              AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
              AND (
                (p.InvoiceId IS NULL)
                OR (inv.Status = N'${PAID_INVOICE_STATUS}')
              )
            )
          )
          AND (${staleCommFrag})
      `);
      out.commissionStaleCount = q.recordset[0]?.Cnt || 0;
    }

    const includeDetails = req.query.includeDetails !== 'false';
    const detailLimit = Math.min(200, Math.max(20, parseInt(String(req.query.detailLimit || '100'), 10) || 100));

    function mapPaymentStaleRow(r, payoutBasis) {
      const gid = r.GroupId ? String(r.GroupId) : null;
      const gname = r.GroupName ? String(r.GroupName).trim() : null;
      const pm = r.PrimaryMemberName ? String(r.PrimaryMemberName).trim() : '';
      const displayName = gid
        ? (gname || 'Group')
        : (pm || 'Individual');
      let anchorDate = null;
      if (r.AnchorDate) {
        anchorDate = r.AnchorDate instanceof Date
          ? r.AnchorDate.toISOString().slice(0, 10)
          : String(r.AnchorDate).slice(0, 10);
      }
      return {
        paymentId: String(r.PaymentId),
        invoiceId: r.InvoiceId ? String(r.InvoiceId) : null,
        invoiceNumber: r.InvoiceNumber != null ? String(r.InvoiceNumber) : null,
        anchorDate,
        payoutBasis,
        sourceType: gid ? 'group' : 'individual',
        groupId: gid,
        groupName: gname,
        householdId: r.HouseholdId ? String(r.HouseholdId) : null,
        primaryMemberId: r.PrimaryMemberId ? String(r.PrimaryMemberId) : null,
        displayName,
      };
    }

    if (includeDetails) {
      out.vendorStaleRows = [];
      out.overrideStaleRows = [];
      out.commissionStaleRows = [];
      out.vendorStaleRowsTruncated = false;
      out.overrideStaleRowsTruncated = false;
      out.commissionStaleRowsTruncated = false;

      const vendorAnchor = vendorPayoutAnchorDateExprForSelect(vendorPayoutBasis);
      const overrideAnchor = vendorPayoutAnchorDateExprForSelect(overridePayoutBasis);
      const topN = detailLimit + 1;

      if (incV && out.vendorStaleCount > 0) {
        const r = pool.request();
        r.input('StartDate', sql.DateTime2, start);
        r.input('EndDate', sql.DateTime2, end);
        r.input('TrailingDays', sql.Int, trailingDays);
        r.input('TenantId', sql.UniqueIdentifier, tenantId);
        const q = await r.query(`
          SELECT TOP (${topN})
            p.PaymentId,
            p.InvoiceId,
            inv.InvoiceNumber,
            CAST(${vendorAnchor} AS DATE) AS AnchorDate,
            p.GroupId,
            p.HouseholdId,
            g.Name AS GroupName,
            hp.MemberId AS PrimaryMemberId,
            LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, N''), N' ', ISNULL(u.LastName, N'')))) AS PrimaryMemberName
          FROM oe.Payments p
          LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
          LEFT JOIN oe.Groups g ON g.GroupId = p.GroupId
          OUTER APPLY (
            SELECT TOP 1 mm.MemberId
            FROM oe.Members mm
            WHERE p.HouseholdId IS NOT NULL
              AND mm.HouseholdId = p.HouseholdId
              AND mm.RelationshipType = 'P'
          ) hp
          LEFT JOIN oe.Members hm ON hm.MemberId = hp.MemberId
          LEFT JOIN oe.Users u ON u.UserId = hm.UserId
          WHERE p.TenantId = @TenantId
            AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
            AND ${fundingGateSql()}
            AND (${staleVendorFrag})
          ORDER BY CAST(${vendorAnchor} AS DATE) ASC, g.Name ASC, u.LastName ASC, u.FirstName ASC
        `);
        let rows = q.recordset || [];
        out.vendorStaleRowsTruncated = rows.length > detailLimit;
        if (out.vendorStaleRowsTruncated) rows = rows.slice(0, detailLimit);
        out.vendorStaleRows = rows.map(row => mapPaymentStaleRow(row, vendorPayoutBasis));
      }

      if (incO && out.overrideStaleCount > 0) {
        const r = pool.request();
        r.input('StartDate', sql.DateTime2, start);
        r.input('EndDate', sql.DateTime2, end);
        r.input('TrailingDays', sql.Int, trailingDays);
        r.input('TenantId', sql.UniqueIdentifier, tenantId);
        const q = await r.query(`
          SELECT TOP (${topN})
            p.PaymentId,
            p.InvoiceId,
            inv.InvoiceNumber,
            CAST(${overrideAnchor} AS DATE) AS AnchorDate,
            p.GroupId,
            p.HouseholdId,
            g.Name AS GroupName,
            hp.MemberId AS PrimaryMemberId,
            LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, N''), N' ', ISNULL(u.LastName, N'')))) AS PrimaryMemberName
          FROM oe.Payments p
          LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
          LEFT JOIN oe.Groups g ON g.GroupId = p.GroupId
          OUTER APPLY (
            SELECT TOP 1 mm.MemberId
            FROM oe.Members mm
            WHERE p.HouseholdId IS NOT NULL
              AND mm.HouseholdId = p.HouseholdId
              AND mm.RelationshipType = 'P'
          ) hp
          LEFT JOIN oe.Members hm ON hm.MemberId = hp.MemberId
          LEFT JOIN oe.Users u ON u.UserId = hm.UserId
          WHERE p.TenantId = @TenantId
            AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
            AND ${fundingGateSql()}
            AND (${staleOverrideFrag})
          ORDER BY CAST(${overrideAnchor} AS DATE) ASC, g.Name ASC, u.LastName ASC, u.FirstName ASC
        `);
        let rows = q.recordset || [];
        out.overrideStaleRowsTruncated = rows.length > detailLimit;
        if (out.overrideStaleRowsTruncated) rows = rows.slice(0, detailLimit);
        out.overrideStaleRows = rows.map(row => mapPaymentStaleRow(row, overridePayoutBasis));
      }

      if (incC && out.commissionStaleCount > 0) {
        const r = pool.request();
        r.input('StartDate', sql.DateTime2, start);
        r.input('EndDate', sql.DateTime2, end);
        r.input('TrailingDays', sql.Int, trailingDays);
        r.input('TenantId', sql.UniqueIdentifier, tenantId);
        const q = await r.query(`
          SELECT TOP (${topN})
            c.CommissionId,
            p.PaymentId,
            p.InvoiceId,
            inv.InvoiceNumber,
            ${COMMISSION_STALE_ANCHOR_DATE_EXPR_SQL} AS AnchorDate,
            p.GroupId,
            p.HouseholdId,
            g.Name AS GroupName,
            hp.MemberId AS PrimaryMemberId,
            LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, N''), N' ', ISNULL(u.LastName, N'')))) AS PrimaryMemberName,
            LTRIM(RTRIM(CONCAT(ISNULL(au.FirstName, N''), N' ', ISNULL(au.LastName, N'')))) AS AgentName
          FROM oe.Commissions c
          INNER JOIN oe.Payments p ON c.PaymentId = p.PaymentId
          LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
          LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
          LEFT JOIN oe.Users au ON au.UserId = a.UserId
          LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
          LEFT JOIN oe.Groups g ON g.GroupId = p.GroupId
          OUTER APPLY (
            SELECT TOP 1 mm.MemberId
            FROM oe.Members mm
            WHERE p.HouseholdId IS NOT NULL
              AND mm.HouseholdId = p.HouseholdId
              AND mm.RelationshipType = 'P'
          ) hp
          LEFT JOIN oe.Members hm ON hm.MemberId = hp.MemberId
          LEFT JOIN oe.Users u ON u.UserId = hm.UserId
          WHERE c.Status = 'Pending'
            AND c.TransactionType IN ('Advance', 'Commission', 'Refund', 'Chargeback')
            AND c.Amount != 0
            AND COALESCE(a.TenantId, ag.TenantId) = @TenantId
            AND (
              (c.TransactionType IN ('Refund', 'Chargeback') AND p.PaymentId IS NOT NULL)
              OR (c.TransactionType NOT IN ('Refund', 'Chargeback')
                AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
                AND (
                  (p.InvoiceId IS NULL)
                  OR (inv.Status = N'${PAID_INVOICE_STATUS}')
                )
              )
            )
            AND (${staleCommFrag})
          ORDER BY ${COMMISSION_STALE_ANCHOR_DATE_EXPR_SQL} ASC, g.Name ASC, u.LastName ASC
        `);
        let rows = q.recordset || [];
        out.commissionStaleRowsTruncated = rows.length > detailLimit;
        if (out.commissionStaleRowsTruncated) rows = rows.slice(0, detailLimit);
        out.commissionStaleRows = (rows || []).map(r => {
          const gid = r.GroupId ? String(r.GroupId) : null;
          const gname = r.GroupName ? String(r.GroupName).trim() : null;
          const pm = r.PrimaryMemberName ? String(r.PrimaryMemberName).trim() : '';
          const ag = r.AgentName ? String(r.AgentName).trim() : 'Agent';
          const client = gid ? (gname || 'Group') : (pm || 'Client');
          let anchorDate = null;
          if (r.AnchorDate) {
            anchorDate = r.AnchorDate instanceof Date
              ? r.AnchorDate.toISOString().slice(0, 10)
              : String(r.AnchorDate).slice(0, 10);
          }
          return {
            commissionId: String(r.CommissionId),
            paymentId: String(r.PaymentId),
            invoiceId: r.InvoiceId ? String(r.InvoiceId) : null,
            invoiceNumber: r.InvoiceNumber != null ? String(r.InvoiceNumber) : null,
            anchorDate,
            sourceType: gid ? 'group' : 'individual',
            groupId: gid,
            groupName: gname,
            householdId: r.HouseholdId ? String(r.HouseholdId) : null,
            primaryMemberId: r.PrimaryMemberId ? String(r.PrimaryMemberId) : null,
            displayName: `${client} · ${ag}`,
          };
        });
      }
    }

    return res.json({ success: true, data: out });
  } catch (error) {
    logger.error('stale-payables-summary', { error: error.message }, 'NACHA');
    return res.status(500).json({ success: false, message: 'Failed to summarize stale payables' });
  }
});

/**
 * GET /api/accounting/nacha/validate
 * Validate NACHA ledger integrity against oe.Payments snapshots.
 *
 * This is a read-only audit endpoint intended as an extra safety layer.
 *
 * Query params:
 * - nachaId?: GUID (validate a single file)
 * - tenantId?: GUID (SysAdmin only; TenantAdmin always restricted to current tenant)
 * - status?: 'Sent' | 'Pending' (default: 'Sent')
 * - payoutType?: string
 * - limit?: number (default: 100, max: 500)
 */
router.get('/validate', requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const request = pool.request();

    const userRoles = getUserRoles(req.user);
    const isSysAdmin = userRoles.includes('SysAdmin');

    const {
      nachaId,
      tenantId: tenantIdQuery,
      status: statusQuery,
      payoutType,
      limit: limitQuery
    } = req.query || {};

    const limit = Math.min(Math.max(parseInt(limitQuery || '100', 10) || 100, 1), 500);
    const status = (statusQuery || 'Sent').toString();

    // Enforce tenant scoping
    const effectiveTenantId = isSysAdmin
      ? (tenantIdQuery ? tenantIdQuery.toString() : null)
      : (req.tenantId || req.user?.TenantId || null);

    request.input('Limit', sql.Int, limit);
    request.input('TenantId', sql.UniqueIdentifier, effectiveTenantId);
    request.input('Status', sql.NVarChar, status);
    request.input('PayoutType', sql.NVarChar, payoutType ? payoutType.toString() : null);
    request.input('NACHAId', sql.UniqueIdentifier, nachaId ? nachaId.toString() : null);

    // 1) Pull generations + their detail totals (for quick mismatch checks)
    const generationsResult = await request.query(`
      WITH gens AS (
        SELECT TOP (@Limit)
          g.NACHAId,
          g.PayoutType,
          g.Status,
          g.TenantId,
          g.StartDate,
          g.EndDate,
          g.TotalPayouts,
          g.TotalAmount,
          g.FileName,
          g.GeneratedDate,
          g.SentDate
        FROM oe.NACHAGenerations g
        WHERE (@NACHAId IS NULL OR g.NACHAId = @NACHAId)
          AND (@TenantId IS NULL OR g.TenantId = @TenantId)
          AND (@Status IS NULL OR g.Status = @Status)
          AND (@PayoutType IS NULL OR g.PayoutType = @PayoutType)
        ORDER BY g.GeneratedDate DESC
      )
      SELECT
        g.*,
        ISNULL(SUM(d.Amount), 0) as DetailsTotalAmount,
        COUNT(d.NACHAPaymentDetailId) as DetailsRowCount,
        COUNT(DISTINCT (UPPER(d.RecipientEntityType) + '_' + CONVERT(nvarchar(36), d.RecipientEntityId))) as DetailsRecipientCount
      FROM gens g
      LEFT JOIN oe.NACHAPaymentDetails d ON d.NACHAId = g.NACHAId
      GROUP BY
        g.NACHAId, g.PayoutType, g.Status, g.TenantId, g.StartDate, g.EndDate,
        g.TotalPayouts, g.TotalAmount, g.FileName, g.GeneratedDate, g.SentDate
      ORDER BY g.GeneratedDate DESC;
    `);

    const generations = generationsResult.recordset || [];
    const nachaIds = generations.map(g => g.NACHAId);

    // If no generations found, return early
    if (nachaIds.length === 0) {
      return res.json({
        success: true,
        summary: { checkedGenerations: 0, errorCount: 0, warningCount: 0 },
        generations: [],
        issues: []
      });
    }

    // 2) Detail-vs-liability checks for Vendor/Tenant on selected generation(s)
    //    For a given NACHAId (or a filtered set), compare the amounts in oe.NACHAPaymentDetails
    //    against owed amounts derived from oe.Payments snapshot JSON.
    const validationRequest = pool.request();
    validationRequest.input('TenantId', sql.UniqueIdentifier, effectiveTenantId);
    validationRequest.input('NACHAId', sql.UniqueIdentifier, nachaId ? nachaId.toString() : null);
    validationRequest.input('Status', sql.NVarChar, status);
    validationRequest.input('PayoutType', sql.NVarChar, payoutType ? payoutType.toString() : null);
    validationRequest.input('Limit', sql.Int, limit);

    const liabilityResult = await validationRequest.query(`
      WITH gens AS (
        SELECT TOP (@Limit) g.NACHAId
        FROM oe.NACHAGenerations g
        WHERE (@NACHAId IS NULL OR g.NACHAId = @NACHAId)
          AND (@TenantId IS NULL OR g.TenantId = @TenantId)
          AND (@Status IS NULL OR g.Status = @Status)
          AND (@PayoutType IS NULL OR g.PayoutType = @PayoutType)
        ORDER BY g.GeneratedDate DESC
      ),
      file_details AS (
        -- Group by both PaymentId and InvoiceId so credit-funded NACHA detail rows
        -- (where d.PaymentId IS NULL) keep their invoice anchor for the join below.
        SELECT
          d.PaymentId,
          d.InvoiceId,
          d.RecipientEntityType,
          d.RecipientEntityId,
          SUM(d.Amount) as LedgerAmount
        FROM oe.NACHAPaymentDetails d
        INNER JOIN oe.NACHAGenerations g ON d.NACHAId = g.NACHAId
        INNER JOIN gens gg ON gg.NACHAId = g.NACHAId
        GROUP BY d.PaymentId, d.InvoiceId, d.RecipientEntityType, d.RecipientEntityId
      ),
      detail_with_payment AS (
        -- LEFT JOIN payments and reach the invoice via either p.InvoiceId or
        -- npd.InvoiceId. Pre-shift this was an INNER JOIN to oe.Payments so
        -- credit-funded detail rows (PaymentId IS NULL) silently disappeared
        -- from validation.
        SELECT
          fd.PaymentId,
          fd.InvoiceId,
          fd.RecipientEntityType,
          fd.RecipientEntityId,
          fd.LedgerAmount,
          COALESCE(inv.NetRate, p.NetRate) as NetRate,
          COALESCE(inv.OverrideRate, p.OverrideRate) as OverrideRate,
          COALESCE(inv.ProductVendorAmounts, p.ProductVendorAmounts) as ProductVendorAmounts,
          COALESCE(inv.ProductOwnerAmounts, p.ProductOwnerAmounts) as ProductOwnerAmounts
        FROM file_details fd
        LEFT JOIN oe.Payments p ON p.PaymentId = fd.PaymentId
        LEFT JOIN oe.Invoices inv ON inv.InvoiceId = COALESCE(p.InvoiceId, fd.InvoiceId)
      )
      SELECT
        dwp.PaymentId,
        dwp.RecipientEntityType,
        dwp.RecipientEntityId,
        dwp.LedgerAmount,
        CASE
          WHEN dwp.RecipientEntityType = 'Vendor' THEN
            COALESCE(vOwed.OwedAmount, dwp.NetRate, 0)
          WHEN dwp.RecipientEntityType = 'Tenant' THEN
            COALESCE(tOwed.OwedAmount, dwp.OverrideRate, 0)
          ELSE NULL
        END as OwedAmount,
        CASE
          WHEN dwp.RecipientEntityType IN ('Vendor','Tenant') AND (CASE
              WHEN dwp.RecipientEntityType = 'Vendor' THEN COALESCE(vOwed.OwedAmount, dwp.NetRate, 0)
              WHEN dwp.RecipientEntityType = 'Tenant' THEN COALESCE(tOwed.OwedAmount, dwp.OverrideRate, 0)
              ELSE 0
            END) IS NULL THEN 1
          ELSE 0
        END as MissingSnapshot
      FROM detail_with_payment dwp
      OUTER APPLY (
        SELECT SUM(x.VendorAmountParsed) as OwedAmount
        FROM (
          -- array format: [{ ProductId, VendorAmount }]
          SELECT TRY_CONVERT(decimal(18,2), j1.VendorAmount) as VendorAmountParsed
          FROM OPENJSON(dwp.ProductVendorAmounts)
            WITH (ProductId uniqueidentifier '$.ProductId', VendorAmount nvarchar(50) '$.VendorAmount') j1
          INNER JOIN oe.Products pr1 ON pr1.ProductId = j1.ProductId
          WHERE pr1.VendorId = dwp.RecipientEntityId

          UNION ALL

          -- object format: { "<ProductId>": { vendorAmount: ... } }
          SELECT TRY_CONVERT(decimal(18,2), COALESCE(JSON_VALUE(j2.value,'$.vendorAmount'), JSON_VALUE(j2.value,'$.VendorAmount'))) as VendorAmountParsed
          FROM OPENJSON(dwp.ProductVendorAmounts) j2
          INNER JOIN oe.Products pr2 ON pr2.ProductId = TRY_CONVERT(uniqueidentifier, j2.[key])
          WHERE pr2.VendorId = dwp.RecipientEntityId
        ) x
      ) vOwed
      OUTER APPLY (
        SELECT SUM(x.OverrideAmountParsed) as OwedAmount
        FROM (
          -- array format: [{ ProductId, OverrideAmount }]
          SELECT TRY_CONVERT(decimal(18,2), j1.OverrideAmount) as OverrideAmountParsed
          FROM OPENJSON(dwp.ProductOwnerAmounts)
            WITH (ProductId uniqueidentifier '$.ProductId', OverrideAmount nvarchar(50) '$.OverrideAmount') j1
          INNER JOIN oe.Products pr1 ON pr1.ProductId = j1.ProductId
          WHERE pr1.ProductOwnerId = dwp.RecipientEntityId

          UNION ALL

          -- object format: { "<ProductId>": { overrideAmount: ... } }
          SELECT TRY_CONVERT(decimal(18,2), COALESCE(JSON_VALUE(j2.value,'$.overrideAmount'), JSON_VALUE(j2.value,'$.OverrideAmount'))) as OverrideAmountParsed
          FROM OPENJSON(dwp.ProductOwnerAmounts) j2
          INNER JOIN oe.Products pr2 ON pr2.ProductId = TRY_CONVERT(uniqueidentifier, j2.[key])
          WHERE pr2.ProductOwnerId = dwp.RecipientEntityId
        ) x
      ) tOwed
      WHERE dwp.RecipientEntityType IN ('Vendor','Tenant');
    `);

    // Build issues list
    const issues = [];

    for (const g of generations) {
      const totalAmount = Number(g.TotalAmount || 0);
      const detailsTotalAmount = Number(g.DetailsTotalAmount || 0);
      const totalPayouts = Number(g.TotalPayouts || 0);
      const detailsRecipientCount = Number(g.DetailsRecipientCount || 0);

      if (Math.abs(totalAmount - detailsTotalAmount) > 0.01) {
        issues.push({
          severity: 'error',
          code: 'GEN_TOTAL_MISMATCH',
          nachaId: g.NACHAId,
          payoutType: g.PayoutType,
          message: `Generation TotalAmount (${totalAmount}) does not match sum of NACHAPaymentDetails (${detailsTotalAmount}).`,
          meta: { totalAmount, detailsTotalAmount }
        });
      }

      // TotalPayouts is the count of grouped payouts written for the file; compare to distinct recipients as a sanity check
      if (totalPayouts > 0 && detailsRecipientCount > 0 && totalPayouts !== detailsRecipientCount) {
        issues.push({
          severity: 'warning',
          code: 'GEN_PAYOUT_COUNT_MISMATCH',
          nachaId: g.NACHAId,
          payoutType: g.PayoutType,
          message: `Generation TotalPayouts (${totalPayouts}) differs from distinct recipients in NACHAPaymentDetails (${detailsRecipientCount}).`,
          meta: { totalPayouts, detailsRecipientCount }
        });
      }
    }

    for (const row of liabilityResult.recordset || []) {
      const ledgerAmount = Number(row.LedgerAmount || 0);
      const owedAmount = row.OwedAmount === null || row.OwedAmount === undefined ? null : Number(row.OwedAmount || 0);

      if (owedAmount === null) {
        issues.push({
          severity: 'warning',
          code: 'MISSING_OWED_CALC',
          paymentId: row.PaymentId,
          recipientEntityType: row.RecipientEntityType,
          recipientEntityId: row.RecipientEntityId,
          message: `Could not compute owed amount from payment snapshots for ${row.RecipientEntityType}.`,
          meta: { ledgerAmount }
        });
        continue;
      }

      if (ledgerAmount - owedAmount > 0.01) {
        issues.push({
          severity: 'error',
          code: 'LEDGER_EXCEEDS_OWED',
          paymentId: row.PaymentId,
          recipientEntityType: row.RecipientEntityType,
          recipientEntityId: row.RecipientEntityId,
          message: `NACHA detail amount (${ledgerAmount}) exceeds owed amount (${owedAmount}) derived from oe.Payments snapshots.`,
          meta: { ledgerAmount, owedAmount }
        });
      }
    }

    const errorCount = issues.filter(i => i.severity === 'error').length;
    const warningCount = issues.filter(i => i.severity === 'warning').length;

    return res.json({
      success: true,
      summary: {
        checkedGenerations: generations.length,
        errorCount,
        warningCount
      },
      generations,
      issues
    });
  } catch (error) {
    logger.error('Error validating NACHA ledger', { error: error.message }, 'NACHA');
    return res.status(500).json({
      success: false,
      message: 'Failed to validate NACHA ledger'
    });
  }
});

/**
 * Helper function to verify tenant access to a NACHA file
 * Returns the NACHA record if access is granted, null otherwise
 */
async function verifyNACHATenantAccess(nachaId, req) {
  const pool = await getPool();
  const request = pool.request();
  request.input('NACHAId', sql.UniqueIdentifier, nachaId);
  
  const result = await request.query(`
    SELECT TenantId
    FROM oe.NACHAGenerations
    WHERE NACHAId = @NACHAId
  `);
  
  if (result.recordset.length === 0) {
    return null; // NACHA not found
  }
  
  const nachaTenantId = result.recordset[0].TenantId;
  
  // Get user roles to check if SysAdmin (can access any tenant)
  const userRoles = getUserRoles(req.user);
  const isSysAdmin = userRoles.includes('SysAdmin');
  
  // Use req.tenantId (set by requireTenantAccess middleware) which respects tenant switching
  const userTenantId = req.tenantId || req.user?.TenantId;
  
  // SysAdmin can access any tenant's NACHA files
  if (isSysAdmin) {
    return { TenantId: nachaTenantId };
  }
  
  // TenantAdmin can only access their own tenant's NACHA files
  if (!userTenantId || nachaTenantId !== userTenantId) {
    return null; // Access denied
  }
  
  return { TenantId: nachaTenantId };
}

/**
 * POST /api/accounting/nacha/preview
 * Preview payouts before generating NACHA file
 */
router.post('/preview', async (req, res) => {
  try {
    console.log('📋 NACHA Preview Request:', req.body);
    const { payoutType, startDate, endDate, tenantId, page = 1, limit = 50 } = req.body;

    if (!payoutType || !startDate || !endDate) {
      console.log('❌ Missing required fields:', { payoutType, startDate, endDate });
      return res.status(400).json({
        success: false,
        message: 'payoutType, startDate, and endDate are required'
      });
    }

    // Convert dates to UTC with proper start/end of day
    // startDate: beginning of day in UTC (00:00:00.000)
    // endDate: end of day in UTC (23:59:59.999)
    const startDateUTC = new Date(startDate);
    startDateUTC.setUTCHours(0, 0, 0, 0);
    
    const endDateUTC = new Date(endDate);
    endDateUTC.setUTCHours(23, 59, 59, 999);
    
    // For Agent Commission Payouts, MUST use oe.Commissions table
    // For Vendor/Product Owner payouts, use payment-based calculation
    let breakdown = [];
    let paymentsMissingProductSnapshot = { count: 0, paymentIds: [] };
    
    if (payoutType === 'Agent Commission Payouts') {
      // CRITICAL: Agent Commission Payouts MUST use oe.Commissions table
      // NO FALLBACK - if no commissions found, return empty result
      try {
        const commissionHelpers = require('../../services/NACHAService.commissions');
        const eligibleCommissions = await commissionHelpers.getEligibleCommissions(
          startDateUTC,
          endDateUTC,
          tenantId || null,
          payoutType
        );
        
        if (eligibleCommissions.length === 0) {
          // Return empty result - no commissions found
          return res.json({
            success: true,
            preview: {
              totalPayouts: 0,
              totalAmount: 0,
              dateRange: { startDate, endDate },
              payoutType,
              pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: 0,
                totalPages: 0
              },
              payoutBreakdown: [],
              paymentsMissingProductSnapshot: { count: 0, paymentIds: [] }
            }
          });
        }
        
        // Use stored commissions from oe.Commissions table (no dynamic recalculation)
        // This includes both agent commissions AND agency overflow commissions (stored with AgencyId)
        breakdown = commissionHelpers.commissionsToPayoutBreakdown(eligibleCommissions);
      } catch (error) {
        logger.error('Error getting eligible commissions', {
          error: error.message,
          payoutType,
          startDate,
          endDate
        }, 'NACHA');
        return res.status(500).json({
          success: false,
          message: `Failed to get eligible commissions: ${error.message}`
        });
      }
    } else {
      // Determine payout basis from tenant settings
      let payoutBasis = payoutType === 'Vendor Payouts' ? 'effectiveEnrollment' : 'paymentReceived';
      try {
        const settingsPool = await getPool();
        const settingsReq = settingsPool.request();
        const effectiveTid = tenantId || req.tenantId || req.user?.TenantId;
        if (effectiveTid) {
          settingsReq.input('TenantId', sql.UniqueIdentifier, effectiveTid);
          const settingsResult = await settingsReq.query('SELECT AdvancedSettings FROM oe.Tenants WHERE TenantId = @TenantId');
          if (settingsResult.recordset.length) {
            const raw = settingsResult.recordset[0].AdvancedSettings;
            const adv = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
            if (payoutType === 'Vendor Payouts' && adv?.payouts?.vendorBasis) {
              payoutBasis = adv.payouts.vendorBasis;
            } else if ((payoutType === 'Product Owner Payouts' || payoutType === 'Product Override Distributions') && adv?.payouts?.overrideBasis) {
              payoutBasis = adv.payouts.overrideBasis;
            }
          }
        }
      } catch (e) {
        logger.warn('Failed to read payout basis setting, using defaults', { error: e.message }, 'NACHA');
      }

      let payments = await nachaService.getUnpaidPayments(
        startDateUTC,
        endDateUTC,
        tenantId || null,
        payoutBasis,
        payoutType
      );

      if (payoutType === 'Vendor Payouts' || payoutType === 'Product Owner Payouts') {
        logger.info('NACHA Preview - Payments from getUnpaidPayments', {
          count: payments.length,
          startDate,
          endDate,
          payoutType,
          payoutBasis
        }, 'NACHA');
      }

      if (payoutType === 'Vendor Payouts' || payoutType === 'Product Owner Payouts') {
        const missing = payments.filter(paymentMissingProductSnapshotJson);
        // payoutSourceId returns InvoiceId for credit-funded rows where PaymentId
        // is NULL, so the alert list never contains silent nulls anymore.
        paymentsMissingProductSnapshot = {
          count: missing.length,
          paymentIds: missing.slice(0, 50).map(payoutSourceId).filter(Boolean)
        };
      }

      logger.info('NACHA Preview - Unpaid payments found', {
        count: payments.length,
        startDate,
        endDate,
        tenantId,
        payoutType
      }, 'NACHA');

      if (payments.length === 0) {
        return res.json({
          success: true,
          preview: {
            totalPayouts: 0,
            totalAmount: 0,
            dateRange: { startDate, endDate },
            payoutType,
            pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              total: 0,
              totalPages: 0
            },
            payoutBreakdown: [],
            paymentsMissingProductSnapshot: { count: 0, paymentIds: [] }
          }
        });
      }

      if (payoutType === 'Vendor Payouts') {
        breakdown = await nachaService.calculateVendorPayoutBreakdown(payments);
      } else {
        breakdown = await nachaService.calculateCommissionPayoutBreakdown(payments, payoutType);
      }
    }
    
    logger.info('NACHA Preview - Breakdown calculated', {
      breakdownCount: breakdown.length,
      payoutType
    }, 'NACHA');
    
    console.log('🔍 Filtering payouts by type:', payoutType);
    const filteredPayouts = nachaService.filterPayoutsByType(breakdown, payoutType);
    console.log('✅ Filtered payouts:', filteredPayouts.length);
    
    logger.info('NACHA Preview - Payouts filtered', {
      filteredCount: filteredPayouts.length,
      payoutType
    }, 'NACHA');
    
    console.log('🔍 Grouping payouts by recipient...');
    const groupedPayouts = nachaService.groupPayoutsByRecipient(filteredPayouts);
    console.log('✅ Grouped payouts:', groupedPayouts.length, 'Total amount:', groupedPayouts.reduce((sum, p) => sum + p.amount, 0));
    
    // Calculate total revenue from unique payment IDs before pagination
    // This ensures we get all payments, not just the paginated ones
    const uniquePaymentRevenues = new Map(); // Map<paymentId, revenue>
    for (const payout of groupedPayouts) {
      if (payout.payoutDetails && Array.isArray(payout.payoutDetails)) {
        for (const detail of payout.payoutDetails) {
          if (detail.paymentId) {
            // Get revenue from detail, or fall back to breakdown item
            let paymentRevenue = detail.revenue;
            if (!paymentRevenue || paymentRevenue === 0) {
              // Try to get from breakdown item
              const breakdownItem = breakdown.find((item) => item.paymentId === detail.paymentId);
              if (breakdownItem) {
                paymentRevenue = breakdownItem.revenue || breakdownItem.paymentAmount || breakdownItem.calculation?.paymentAmount || 0;
              }
            }
            
            if (paymentRevenue > 0) {
              // Only set if not already set (first occurrence wins, or use max if different)
              if (!uniquePaymentRevenues.has(detail.paymentId)) {
                uniquePaymentRevenues.set(detail.paymentId, paymentRevenue);
              } else {
                // If already set, use the maximum (should be same, but handle edge cases)
                const existing = uniquePaymentRevenues.get(detail.paymentId);
                if (paymentRevenue > existing) {
                  uniquePaymentRevenues.set(detail.paymentId, paymentRevenue);
                }
              }
            }
          }
        }
      }
    }
    const totalRevenue = Array.from(uniquePaymentRevenues.values()).reduce((sum, revenue) => sum + revenue, 0);
    
    logger.info('NACHA Preview - Payouts grouped', {
      groupedCount: groupedPayouts.length,
      totalAmount: groupedPayouts.reduce((sum, p) => sum + p.amount, 0)
    }, 'NACHA');

    // Apply pagination before fetching entity names (more efficient)
    const offset = (page - 1) * limit;
    const paginatedPayouts = groupedPayouts.slice(offset, offset + limit);
    console.log(`✅ Paginated payouts: showing ${paginatedPayouts.length} of ${groupedPayouts.length}`);

    // Fetch entity names and ACH account status for paginated payouts
    console.log('🔍 Fetching entity names and ACH status...');
    const achService = require('../../services/ACHService');
    const payoutsWithNames = await Promise.all(
      paginatedPayouts.map(async (payout) => {
        try {
          // Handle "UNKNOWN" entries specially - these are missing override destinations
          if (payout.entityId === 'UNKNOWN' || payout.entityId === 'unknown') {
            const productName = payout.productName || 'Unknown Product';
            const entityName = `⚠️ Unknown Destination - ${productName}`;
            return {
              ...payout,
              entityName,
              hasACH: false,
              achStatus: null,
              isUnknownDestination: true,
              missingOverrideDestination: true
            };
          }
          
          // Product Owner: entityId is OverrideACHId when present — resolve name from ProductOverrideACH
          let entityName = null;
          if (payout.entityType === 'Tenant' && payout.overrideAchId && (payoutType === 'Product Owner Payouts' || payoutType === 'Product Override Distributions')) {
            const pool = await getPool();
            const req = pool.request();
            req.input('OverrideACHId', sql.UniqueIdentifier, payout.overrideAchId);
            const overrideRow = await req.query(`
              SELECT AccountName, AccountHolderName, TenantId
              FROM oe.ProductOverrideACH
              WHERE OverrideACHId = @OverrideACHId AND IsActive = 1
            `);
            if (overrideRow.recordset && overrideRow.recordset.length > 0) {
              const r = overrideRow.recordset[0];
              entityName = r.AccountName || r.AccountHolderName || null;
              if (!entityName && r.TenantId) {
                entityName = await nachaService.getEntityName('Tenant', r.TenantId).catch(() => null);
              }
            }
          }
          if (entityName == null) {
            entityName = await nachaService.getEntityName(
              payout.entityType,
              payout.entityId
            );
          }
          
          // Log unknown entities for debugging
          if (!entityName || entityName === 'Unknown' || entityName === payout.entityId) {
            console.warn('⚠️ Unknown entity found in payout:', {
              entityType: payout.entityType,
              entityId: payout.entityId,
              amount: payout.amount,
              revenue: payout.revenue,
              payoutDetails: payout.payoutDetails?.length || 0,
              ruleName: payout.ruleName,
              isOverflow: payout.isOverflow,
              isOverride: payout.isOverride
            });
            
            // Try to query the database directly to see if entity exists
            try {
              const pool = await getPool();
              const debugRequest = pool.request();
              debugRequest.input('EntityId', sql.UniqueIdentifier, payout.entityId);
              
              if (payout.entityType === 'Tenant') {
                const debugResult = await debugRequest.query(`
                  SELECT TenantId, Name, Status, CreatedDate 
                  FROM oe.Tenants 
                  WHERE TenantId = @EntityId
                `);
                console.warn('🔍 Tenant lookup result:', debugResult.recordset);
                
                // Also check as Agency (overflow can go to agencies)
                const agencyRequest = pool.request();
                agencyRequest.input('AgencyId', sql.UniqueIdentifier, payout.entityId);
                const agencyResult = await agencyRequest.query(`
                  SELECT AgencyId, AgencyName, Status, CreatedDate
                  FROM oe.Agencies
                  WHERE AgencyId = @AgencyId
                `);
                console.warn('🔍 Agency lookup result:', agencyResult.recordset);
                
                // Also check if it's a ProductOwnerId in Products
                const productRequest = pool.request();
                productRequest.input('TenantId', sql.UniqueIdentifier, payout.entityId);
                const productResult = await productRequest.query(`
                  SELECT ProductId, Name, ProductOwnerId, VendorId
                  FROM oe.Products
                  WHERE ProductOwnerId = @TenantId
                `);
                console.warn('🔍 Products with this ProductOwnerId:', productResult.recordset);
                
                // Check payments that might have this as ProductOwnerId
                const paymentRequest = pool.request();
                paymentRequest.input('TenantId', sql.UniqueIdentifier, payout.entityId);
                const paymentResult = await paymentRequest.query(`
                  SELECT TOP 5 p.PaymentId, p.Amount,
                    COALESCE(inv.OverrideRate, p.OverrideRate) as OverrideRate,
                    COALESCE(inv.Commission, p.Commission) as Commission,
                    COALESCE(inv.NetRate, p.NetRate) as NetRate,
                    COALESCE(inv.SystemFees, p.SystemFees) as SystemFees,
                    (p.Amount
                      - COALESCE(inv.NetRate, p.NetRate)
                      - COALESCE(inv.OverrideRate, p.OverrideRate)
                      - COALESCE(inv.Commission, p.Commission)
                      - ISNULL(COALESCE(inv.SystemFees, p.SystemFees), 0)) as CalculatedOverflow,
                    pr.ProductId, pr.Name as ProductName
                  FROM oe.Payments p
                  LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
                  LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
                  LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
                  WHERE pr.ProductOwnerId = @TenantId
                    AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
                  ORDER BY p.PaymentDate DESC
                `);
                console.warn('🔍 Payments with this ProductOwnerId:', paymentResult.recordset);
                console.warn('💰 Amount breakdown for unknown entity:', {
                  totalAmount: payout.amount,
                  revenue: payout.revenue,
                  isOverflow: payout.isOverflow,
                  isOverride: payout.isOverride,
                  ruleName: payout.ruleName,
                  paymentDetails: payout.payoutDetails?.map(pd => ({
                    paymentId: pd.paymentId,
                    amount: pd.amount
                  }))
                });
              }
            } catch (debugError) {
              console.error('Error in debug query:', debugError.message);
            }
          }
          
          // Check ACH account status
          let hasACH = false;
          let achStatus = null;
          let achSplits = null; // For vendor splits
          
          try {
            // For vendors, get all active ACH accounts to show splits
            if (payout.entityType === 'Vendor') {
              const achAccounts = await achService.getAllACHAccounts(
                payout.entityType,
                payout.entityId,
                false // don't need decrypted for preview
              );
              
              const activeAccounts = achAccounts.filter(acc => acc.Status === 'Active');
              hasACH = activeAccounts.length > 0;
              
              if (activeAccounts.length > 0) {
                // Calculate total distribution percentage
                const totalDistribution = activeAccounts.reduce((sum, acc) => {
                  return sum + (Number(acc.DistributionPercentage) || 0);
                }, 0);
                
                // Calculate split amounts
                const useEqualDistribution = totalDistribution === 0 || totalDistribution > 100;
                const distributionPerAccount = useEqualDistribution 
                  ? 100 / activeAccounts.length 
                  : null;
                
                achSplits = activeAccounts.map(acc => {
                  const distributionPct = useEqualDistribution 
                    ? distributionPerAccount 
                    : (Number(acc.DistributionPercentage) || 0);
                  const splitAmount = Math.round((payout.amount * distributionPct / 100) * 100) / 100;
                  
                  return {
                    achAccountId: acc.ACHAccountId,
                    accountHolderName: acc.AccountHolderName,
                    bankName: acc.BankName,
                    accountType: acc.AccountType,
                    accountNumberLast4: acc.AccountNumberLast4,
                    distributionPercentage: distributionPct,
                    splitAmount: splitAmount,
                    status: acc.Status
                  };
                });
                
                achStatus = 'Active';
              } else {
                achStatus = null;
              }
            } else if (payout.entityType === 'Tenant' && (payoutType === 'Product Owner Payouts' || payoutType === 'Product Override Distributions')) {
              // For product owner payouts, use ProductOverrideACH. When overrideAchId is set, use that account; else TenantId + TOP 1.
              const pool = await getPool();
              const request = pool.request();
              let overrideResult;
              if (payout.overrideAchId) {
                request.input('OverrideACHId', sql.UniqueIdentifier, payout.overrideAchId);
                overrideResult = await request.query(`
                  SELECT OverrideACHId, AccountHolderName, BankName, BankAccountType, IsActive, IsDefault, VerificationStatus
                  FROM oe.ProductOverrideACH
                  WHERE OverrideACHId = @OverrideACHId AND IsActive = 1
                `);
              } else {
                request.input('TenantId', sql.UniqueIdentifier, payout.tenantId || payout.entityId);
                overrideResult = await request.query(`
                  SELECT TOP 1 OverrideACHId, AccountHolderName, BankName, BankAccountType, IsActive, IsDefault, VerificationStatus
                  FROM oe.ProductOverrideACH
                  WHERE TenantId = @TenantId AND IsActive = 1
                  ORDER BY IsDefault DESC, CreatedDate DESC
                `);
              }
              if (overrideResult.recordset.length > 0) {
                const overrideAccount = overrideResult.recordset[0];
                hasACH = overrideAccount.IsActive === true || overrideAccount.IsActive === 1;
                achStatus = hasACH ? 'Active' : null;
              } else {
                hasACH = false;
                achStatus = null;
              }
            } else if (payout.entityType === 'Agent') {
              // For agents, check oe.AgentBankInfo table (not oe.ACHAccounts)
              const pool = await getPool();
              const request = pool.request();
              request.input('AgentId', sql.UniqueIdentifier, payout.entityId);

              const bankInfoResult = await request.query(`
                SELECT TOP 1
                  BankInfoId,
                  AgentId,
                  BankName,
                  AccountName,
                  AccountType,
                  RoutingNumber,
                  Status,
                  IsDefault
                FROM oe.AgentBankInfo
                WHERE AgentId = @AgentId 
                  AND Status = 'Active'
                ORDER BY IsDefault DESC, CreatedDate DESC
              `);

              if (bankInfoResult.recordset.length > 0) {
                hasACH = true;
                achStatus = 'Active';
              } else {
                hasACH = false;
                achStatus = null;
              }
            } else {
              // For non-vendors and non-product-owner payouts (Tenants, etc.), use single account check
              const achAccount = await achService.getACHAccount(
                payout.entityType,
                payout.entityId,
                false // don't need decrypted for preview
              );
              hasACH = achAccount && achAccount.Status === 'Active';
              achStatus = achAccount ? achAccount.Status : null;
            }
          } catch (achError) {
            // No ACH account found - this is expected for some entities
            hasACH = false;
            achStatus = null;
          }
          
          // Calculate revenue for vendors and product owners from breakdown
          let revenue = payout.revenue;
          if (!revenue && payout.payoutDetails && payout.payoutDetails.length > 0) {
            // Sum payment amounts from all payout details
            revenue = payout.payoutDetails.reduce((sum, detail) => {
              // Try to get payment amount from breakdown item
              const breakdownItem = breakdown.find((item) => item.paymentId === detail.paymentId);
              if (breakdownItem && breakdownItem.calculation && breakdownItem.calculation.paymentAmount) {
                return sum + breakdownItem.calculation.paymentAmount;
              }
              return sum;
            }, 0);
          }
          
          return {
            ...payout,
            entityName,
            hasACH,
            achStatus,
            achSplits, // Vendor split information
            // Preserve commission details from breakdown
            revenue: revenue || payout.revenue,
            commissionPool: payout.commissionPool,
            ruleId: payout.ruleId,
            ruleName: payout.ruleName,
            ruleIds: payout.ruleIds,
            commissionType: payout.commissionType,
            tierLevel: payout.tierLevel,
            commissionId: payout.commissionId
          };
        } catch (error) {
          // If entity name lookup fails, still include it but mark as unknown
          console.error('❌ Error fetching entity name for payout:', {
            entityType: payout.entityType,
            entityId: payout.entityId,
            amount: payout.amount,
            error: error.message,
            stack: error.stack
          });
          
          // Return payout with unknown name so it can be displayed and investigated
          return {
            ...payout,
            entityName: 'Unknown',
            hasACH: false,
            achStatus: null,
            achSplits: null,
            revenue: payout.revenue || 0,
            commissionPool: payout.commissionPool,
            ruleId: payout.ruleId,
            ruleName: payout.ruleName,
            ruleIds: payout.ruleIds,
            commissionType: payout.commissionType,
            tierLevel: payout.tierLevel,
            commissionId: payout.commissionId,
            _debug: {
              error: error.message,
              entityType: payout.entityType,
              entityId: payout.entityId
            }
          };
        }
      })
    );
    
    // Filter out null payouts (from errors), but keep unknown entities for investigation
    const validPayouts = payoutsWithNames.filter(p => p !== null);
    console.log('✅ Entity names and ACH status fetched. Total payouts:', validPayouts.length);
    
    // Expand vendor payouts with splits into separate line items
    const expandedPayouts = [];
    for (const payout of validPayouts) {
      // For vendors with multiple ACH accounts, create separate entries for each split
      if (payout.entityType === 'Vendor' && payout.achSplits && payout.achSplits.length > 1) {
        // Create a separate payout entry for each ACH account split
        for (const split of payout.achSplits) {
          expandedPayouts.push({
            ...payout,
            // Override amount with split amount
            amount: split.splitAmount,
            // Store original amount for reference
            originalAmount: payout.amount,
            // Update entity name to include account holder name
            entityName: `${payout.entityName} - ${split.accountHolderName}`,
            // Store split information
            distributionPercentage: split.distributionPercentage,
            achAccountId: split.achAccountId,
            accountHolderName: split.accountHolderName,
            bankName: split.bankName,
            accountType: split.accountType,
            accountNumberLast4: split.accountNumberLast4,
            // Indicate this is a split payout
            isSplit: true,
            splitIndex: payout.achSplits.indexOf(split),
            totalSplits: payout.achSplits.length,
            // Remove achSplits array since we've expanded it
            achSplits: undefined
          });
        }
      } else {
        // For non-split payouts, add as-is (remove achSplits if it exists but has only 1 item)
        const singlePayout = { ...payout };
        if (singlePayout.achSplits && singlePayout.achSplits.length === 1) {
          // Single account, no need for splits array
          singlePayout.achSplits = undefined;
        }
        expandedPayouts.push(singlePayout);
      }
    }
    
    console.log('✅ Expanded vendor splits. Total payouts after expansion:', expandedPayouts.length);
    
    // Log summary of unknown entities
    const unknownPayouts = expandedPayouts.filter(p => !p.entityName || p.entityName === 'Unknown' || p.entityName === p.entityId);
    if (unknownPayouts.length > 0) {
      console.warn('⚠️ Found unknown entities:', unknownPayouts.map(p => ({
        entityType: p.entityType,
        entityId: p.entityId,
        amount: p.amount,
        revenue: p.revenue
      })));
    }

    // Phase 6 — Enrich each payout row with pending clawback info so the
    // wizard preview shows Gross / Clawback / Net for each recipient. Mirrors
    // exactly what NACHA generation will do when committed:
    //   - Agent / Agency: clawback comes from oe.Commissions negatives. They
    //     are already netted into `amount` via the eligibility query, so
    //     gross = amount + clawback and net = max(0, amount).
    //   - Vendor / Tenant: clawback comes from oe.PayoutClawbacks. They have
    //     NOT been netted yet at this stage, so gross = amount and
    //     net = max(0, amount - clawback).
    try {
      const effectiveTid = tenantId || req.tenantId || req.user?.TenantId;
      if (effectiveTid) {
        const agentRecipients = [];
        const vendorIds = new Set();
        const tenantIds = new Set();
        for (const p of expandedPayouts) {
          if (!p || !p.entityId) continue;
          if (p.entityType === 'Agent' || p.entityType === 'Agency') {
            agentRecipients.push({ entityType: p.entityType, entityId: p.entityId });
          } else if (p.entityType === 'Vendor') {
            vendorIds.add(p.entityId);
          } else if (p.entityType === 'Tenant') {
            tenantIds.add(p.entityId);
          }
        }

        const [commMap, vendorMap, tenantMap] = await Promise.all([
          agentRecipients.length > 0
            ? clawbackBalances.getCommissionClawbackBalances({ tenantId: effectiveTid, recipients: agentRecipients })
            : Promise.resolve(new Map()),
          vendorIds.size > 0
            ? clawbackBalances.getPayoutClawbackBalances({
                tenantId: effectiveTid,
                payoutType: PayoutClawbacks.PAYOUT_TYPES.VENDOR,
                recipientEntityIds: Array.from(vendorIds)
              })
            : Promise.resolve(new Map()),
          tenantIds.size > 0
            ? clawbackBalances.getPayoutClawbackBalances({
                tenantId: effectiveTid,
                payoutType: PayoutClawbacks.PAYOUT_TYPES.TENANT_OVERRIDE,
                recipientEntityIds: Array.from(tenantIds)
              })
            : Promise.resolve(new Map())
        ]);

        for (const p of expandedPayouts) {
          if (!p || !p.entityId) continue;
          const amt = Number(p.amount) || 0;
          let pendingClawback = 0;
          let count = 0;
          let gross = amt;
          let net = amt;

          if (p.entityType === 'Agent' || p.entityType === 'Agency') {
            const cb = commMap.get(`${p.entityType}_${p.entityId}`);
            pendingClawback = cb ? Math.round((cb.amount || 0) * 100) / 100 : 0;
            count = cb ? Number(cb.count || 0) : 0;
            // Eligibility query already netted negatives into `amount`.
            gross = Math.round((amt + pendingClawback) * 100) / 100;
            net = Math.round(Math.max(0, amt) * 100) / 100;
          } else if (p.entityType === 'Vendor' || p.entityType === 'Tenant') {
            const m = p.entityType === 'Vendor' ? vendorMap : tenantMap;
            const cb = m.get(p.entityId);
            pendingClawback = cb ? Math.round((cb.amount || 0) * 100) / 100 : 0;
            count = cb ? Number(cb.count || 0) : 0;
            // Vendor / tenant clawbacks have NOT been netted yet at preview.
            gross = Math.round(amt * 100) / 100;
            net = Math.round(Math.max(0, amt - pendingClawback) * 100) / 100;
          }

          // Cap reported clawback by gross so we never imply we'll deduct more
          // than what's payable. Anything above carries forward to the next
          // cycle.
          const clawbackAppliedThisCycle = Math.min(pendingClawback, gross);
          const clawbackCarryForward = Math.round((pendingClawback - clawbackAppliedThisCycle) * 100) / 100;

          p.pendingClawbackAmount = pendingClawback;
          p.pendingClawbackCount = count;
          p.clawbackAppliedThisCycle = Math.round(clawbackAppliedThisCycle * 100) / 100;
          p.clawbackCarryForwardAmount = clawbackCarryForward;
          p.grossAmount = gross;
          p.netAmount = net;
        }
      }
    } catch (clawErr) {
      logger.warn('NACHA preview clawback enrichment failed', { error: clawErr.message }, 'NACHA');
    }

    // Get summary statistics
    // Use original grouped payouts for totals (before split expansion)
    const totalAmount = groupedPayouts.reduce((sum, p) => sum + p.amount, 0);
    // Count unique vendors/entities, not split entries
    const totalPayouts = groupedPayouts.length;
    // totalRevenue is already calculated above from unique payment IDs

    // Roll up clawback totals across the whole preview so the wizard summary
    // can show a one-line "Clawback applied: $X" / "Carry forward: $Y".
    let totalClawbackApplied = 0;
    let totalClawbackCarryForward = 0;
    for (const p of expandedPayouts) {
      totalClawbackApplied += Number(p.clawbackAppliedThisCycle || 0);
      totalClawbackCarryForward += Number(p.clawbackCarryForwardAmount || 0);
    }
    totalClawbackApplied = Math.round(totalClawbackApplied * 100) / 100;
    totalClawbackCarryForward = Math.round(totalClawbackCarryForward * 100) / 100;
    const totalNetAmount = Math.round((totalAmount - 0) * 100) / 100; // amount already reflects netting where applicable

    res.json({
      success: true,
      preview: {
        totalPayouts,
        totalAmount,
        totalRevenue, // Add totalRevenue calculated from unique payment IDs
        totalClawbackApplied,
        totalClawbackCarryForward,
        totalNetAmount,
        dateRange: { startDate, endDate },
        payoutType,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: totalPayouts,
          totalPages: Math.ceil(totalPayouts / parseInt(limit))
        },
        payoutBreakdown: expandedPayouts,
        excludedPaymentsDueToHoldPeriods: [],
        paymentsMissingProductSnapshot
      }
    });
  } catch (error) {
    logger.error('Error previewing NACHA', {
      error: error.message,
      stack: error.stack,
      body: req.body
    }, 'NACHA');
    console.error('❌ NACHA Preview Error:', error);
    console.error('❌ Error Stack:', error.stack);
    res.status(500).json({
      success: false,
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * POST /api/accounting/nacha/generate
 * Generate NACHA file
 */
router.post('/generate', async (req, res) => {
  try {
    const { payoutType, startDate, endDate, tenantId, vendorIds, agentIds, agencyIds, fundingAchAccountId, companyIdentification, excludedPaymentIds, excludedInvoiceIds } = req.body;

    if (!payoutType || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'payoutType, startDate, and endDate are required'
      });
    }

    // Company Identification is required for NACHA file generation (9-digit EIN or 10 digits).
    // NACHA generation will prepend "1" for 9-digit EIN per standard convention.
    const companyIdDigits = String(companyIdentification || '').replace(/\D/g, '');
    if (!companyIdentification || (companyIdDigits.length !== 9 && companyIdDigits.length !== 10)) {
      return res.status(400).json({
        success: false,
        message: 'companyIdentification is required and must be 9 digits (EIN) or 10 digits'
      });
    }

    // Convert dates to UTC with proper start/end of day
    const startDateUTC = new Date(startDate);
    startDateUTC.setUTCHours(0, 0, 0, 0);
    
    const endDateUTC = new Date(endDate);
    endDateUTC.setUTCHours(23, 59, 59, 999);

    // Determine payout basis from tenant settings
    let payoutBasis = payoutType === 'Vendor Payouts' ? 'effectiveEnrollment' : 'paymentReceived';
    try {
      const settingsPool = await getPool();
      const settingsReq = settingsPool.request();
      const effectiveTid = tenantId || req.tenantId || req.user?.TenantId;
      if (effectiveTid) {
        settingsReq.input('SettingsTenantId', sql.UniqueIdentifier, effectiveTid);
        const settingsResult = await settingsReq.query('SELECT AdvancedSettings FROM oe.Tenants WHERE TenantId = @SettingsTenantId');
        if (settingsResult.recordset.length) {
          const raw = settingsResult.recordset[0].AdvancedSettings;
          const adv = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
          if (payoutType === 'Vendor Payouts' && adv?.payouts?.vendorBasis) {
            payoutBasis = adv.payouts.vendorBasis;
          } else if ((payoutType === 'Product Owner Payouts' || payoutType === 'Product Override Distributions') && adv?.payouts?.overrideBasis) {
            payoutBasis = adv.payouts.overrideBasis;
          }
        }
      }
    } catch (e) {
      // Use defaults on failure
    }

    const result = await nachaService.generateNACHA({
      payoutType,
      startDate: startDateUTC,
      endDate: endDateUTC,
      tenantId: tenantId || null,
      vendorIds: vendorIds && Array.isArray(vendorIds) && vendorIds.length > 0 ? vendorIds : null,
      agentIds: agentIds && Array.isArray(agentIds) && agentIds.length > 0 ? agentIds : null,
      agencyIds: agencyIds && Array.isArray(agencyIds) && agencyIds.length > 0 ? agencyIds : null,
      fundingAchAccountId: fundingAchAccountId || null,
      companyIdentification: String(companyIdentification),
      // Per-row exclusions from preview UI; service filters payouts whose payment/invoice is here
      excludedPaymentIds: Array.isArray(excludedPaymentIds) && excludedPaymentIds.length > 0 ? excludedPaymentIds : null,
      excludedInvoiceIds: Array.isArray(excludedInvoiceIds) && excludedInvoiceIds.length > 0 ? excludedInvoiceIds : null,
      userId: req.user.UserId,
      payoutBasis
    });

    // Convert PascalCase to camelCase for frontend compatibility
    const nacha = {
      nachaId: result.NACHAId || result.nachaId,
      fileName: result.FileName || result.fileName,
      totalPayouts: result.TotalPayouts || result.totalPayouts,
      totalAmount: result.TotalAmount || result.totalAmount,
      status: result.Status || result.status,
      generatedDate: result.GeneratedDate || result.generatedDate,
      payoutType: result.PayoutType || result.payoutType,
      startDate: result.StartDate || result.startDate,
      endDate: result.EndDate || result.endDate,
      sentDate: result.SentDate || result.sentDate,
      includedPayouts: result.includedPayouts || result.totalPayouts,
      includedAmount: result.includedAmount || result.totalAmount,
      excludedPayouts: result.excludedPayouts || 0,
      excludedAmount: result.excludedAmount || 0,
      excludedPayoutDetails: result.excludedPayoutDetails || [],
      warnings: result.warnings || []
    };

    res.json({
      success: true,
      nacha
    });
  } catch (error) {
    logger.error('Error generating NACHA', {
      error: error.message,
      body: req.body
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * GET /api/accounting/nacha
 * List all NACHA generations with pagination
 * Filters by tenant for TenantAdmin users, respects tenant switching
 */
const isValidGuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value.trim());

router.get('/', requireTenantAccess, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, payoutType, startDate, endDate, vendorId, agentId } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const pool = await getPool();
    const request = pool.request();

    request.input('Offset', sql.Int, offset);
    request.input('Limit', sql.Int, parseInt(limit));

    // Get user roles to check if SysAdmin (can see all tenants)
    const userRoles = getUserRoles(req.user);
    const isSysAdmin = userRoles.includes('SysAdmin');
    
    // Use req.tenantId (set by requireTenantAccess middleware) which respects tenant switching
    const tenantId = req.tenantId || req.user?.TenantId;

    const vendorFilterSql =
      vendorId && isValidGuid(String(vendorId))
        ? ` AND EXISTS (
            SELECT 1 FROM oe.NACHAPaymentDetails npd
            WHERE npd.NACHAId = oe.NACHAGenerations.NACHAId
              AND npd.RecipientEntityType = N'Vendor'
              AND npd.RecipientEntityId = @VendorId
              AND npd.Amount > 0
          )`
        : '';

    // Agent filter matches files containing payout lines for an agent OR agency.
    // The tenant-admin agents view returns AgentId or AgencyId in the same column,
    // so a single GUID is checked against both RecipientEntityType values.
    const agentFilterSql =
      agentId && isValidGuid(String(agentId))
        ? ` AND EXISTS (
            SELECT 1 FROM oe.NACHAPaymentDetails npd
            WHERE npd.NACHAId = oe.NACHAGenerations.NACHAId
              AND npd.RecipientEntityType IN (N'Agent', N'Agency')
              AND npd.RecipientEntityId = @AgentFilterId
              AND npd.Amount > 0
          )`
        : '';

    let whereClause = 'WHERE 1=1';
    
    // Filter by tenant for non-SysAdmin users
    if (!isSysAdmin) {
      if (!tenantId) {
        logger.error('TenantAdmin missing TenantId', { userId: req.user.UserId }, 'NACHA');
        return res.status(400).json({
          success: false,
          message: 'TenantId not found for user'
        });
      }
      request.input('TenantId', sql.UniqueIdentifier, tenantId);
      whereClause += ' AND TenantId = @TenantId';
    } else if (tenantId) {
      // SysAdmin can optionally filter by tenantId if provided
      request.input('TenantId', sql.UniqueIdentifier, tenantId);
      whereClause += ' AND TenantId = @TenantId';
    }
    
    if (status) {
      request.input('Status', sql.NVarChar, status);
      whereClause += ' AND Status = @Status';
    }
    if (payoutType) {
      request.input('PayoutType', sql.NVarChar, payoutType);
      whereClause += ' AND PayoutType = @PayoutType';
    }
    if (startDate) {
      const startDateUTC = new Date(startDate);
      startDateUTC.setUTCHours(0, 0, 0, 0);
      request.input('StartDate', sql.DateTime2, startDateUTC);
      whereClause += ' AND StartDate >= @StartDate';
    }
    if (endDate) {
      const endDateUTC = new Date(endDate);
      endDateUTC.setUTCHours(23, 59, 59, 999);
      request.input('EndDate', sql.DateTime2, endDateUTC);
      whereClause += ' AND EndDate <= @EndDate';
    }
    if (vendorFilterSql) {
      request.input('VendorId', sql.UniqueIdentifier, String(vendorId).trim());
      whereClause += vendorFilterSql;
    }
    if (agentFilterSql) {
      request.input('AgentFilterId', sql.UniqueIdentifier, String(agentId).trim());
      whereClause += agentFilterSql;
    }

    const result = await request.query(`
      SELECT 
        NACHAId,
        PayoutType,
        StartDate,
        EndDate,
        Status,
        TotalPayouts,
        TotalAmount,
        FileName,
        GeneratedDate,
        SentDate,
        GeneratedBy,
        ReissueOfNACHAId
      FROM oe.NACHAGenerations
      ${whereClause}
      ORDER BY GeneratedDate DESC
      OFFSET @Offset ROWS
      FETCH NEXT @Limit ROWS ONLY
    `);

    const countRequest = pool.request();
    
    // Apply same tenant filtering to count query
    let countWhereClause = 'WHERE 1=1';
    if (!isSysAdmin && tenantId) {
      countRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
      countWhereClause += ' AND TenantId = @TenantId';
    } else if (isSysAdmin && tenantId) {
      countRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
      countWhereClause += ' AND TenantId = @TenantId';
    }
    
    if (status) {
      countRequest.input('Status', sql.NVarChar, status);
      countWhereClause += ' AND Status = @Status';
    }
    if (payoutType) {
      countRequest.input('PayoutType', sql.NVarChar, payoutType);
      countWhereClause += ' AND PayoutType = @PayoutType';
    }
    if (startDate) {
      const startDateUTC = new Date(startDate);
      startDateUTC.setUTCHours(0, 0, 0, 0);
      countRequest.input('StartDate', sql.DateTime2, startDateUTC);
      countWhereClause += ' AND StartDate >= @StartDate';
    }
    if (endDate) {
      const endDateUTC = new Date(endDate);
      endDateUTC.setUTCHours(23, 59, 59, 999);
      countRequest.input('EndDate', sql.DateTime2, endDateUTC);
      countWhereClause += ' AND EndDate <= @EndDate';
    }
    if (vendorFilterSql) {
      countRequest.input('VendorId', sql.UniqueIdentifier, String(vendorId).trim());
      countWhereClause += vendorFilterSql;
    }
    if (agentFilterSql) {
      countRequest.input('AgentFilterId', sql.UniqueIdentifier, String(agentId).trim());
      countWhereClause += agentFilterSql;
    }

    const countResult = await countRequest.query(`
      SELECT COUNT(*) as Total
      FROM oe.NACHAGenerations
      ${countWhereClause}
    `);

    const pageRows = result.recordset || [];
    const nachaIds = pageRows.map((r) => r.NACHAId);
    const vendorNamesByNachaId = new Map();
    if (nachaIds.length > 0) {
      const vReq = pool.request();
      nachaIds.forEach((id, i) => {
        vReq.input(`nid${i}`, sql.UniqueIdentifier, id);
      });
      const inList = nachaIds.map((_, i) => `@nid${i}`).join(',');
      const vResult = await vReq.query(`
        SELECT DISTINCT npd.NACHAId, v.VendorName
        FROM oe.NACHAPaymentDetails npd
        INNER JOIN oe.Vendors v ON npd.RecipientEntityId = v.VendorId
        WHERE npd.NACHAId IN (${inList})
          AND npd.RecipientEntityType = N'Vendor'
          AND npd.Amount > 0
        ORDER BY npd.NACHAId, v.VendorName
      `);
      for (const row of vResult.recordset || []) {
        const nid = String(row.NACHAId);
        const name = (row.VendorName || '').trim();
        if (!name) continue;
        if (!vendorNamesByNachaId.has(nid)) {
          vendorNamesByNachaId.set(nid, []);
        }
        const arr = vendorNamesByNachaId.get(nid);
        if (!arr.includes(name)) arr.push(name);
      }
    }

    // Convert PascalCase to camelCase for frontend compatibility
    const nachas = pageRows.map((nacha) => {
      const nid = String(nacha.NACHAId);
      return {
        nachaId: nacha.NACHAId,
        fileName: nacha.FileName,
        totalPayouts: nacha.TotalPayouts,
        totalAmount: nacha.TotalAmount,
        status: nacha.Status,
        generatedDate: nacha.GeneratedDate,
        payoutType: nacha.PayoutType,
        startDate: nacha.StartDate,
        endDate: nacha.EndDate,
        sentDate: nacha.SentDate,
        reissueOfNachaId: nacha.ReissueOfNACHAId || null,
        vendorNames: vendorNamesByNachaId.get(nid) || []
      };
    });

    res.json({
      success: true,
      nachas,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult.recordset[0].Total,
        totalPages: Math.ceil(countResult.recordset[0].Total / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('Error listing NACHA files', {
      error: error.message
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: 'Failed to list NACHA files'
    });
  }
});

/**
 * GET /api/accounting/nacha/:nachaId
 * Get NACHA details
 * Verifies tenant access before returning details
 */
router.get('/:nachaId', requireTenantAccess, async (req, res) => {
  try {
    const { nachaId } = req.params;
    
    // Verify tenant access
    const accessCheck = await verifyNACHATenantAccess(nachaId, req);
    if (!accessCheck) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: NACHA file not found or belongs to a different tenant'
      });
    }
    
    const nacha = await nachaService.getNACHADetails(nachaId);

    if (!nacha) {
      return res.status(404).json({
        success: false,
        message: 'NACHA file not found'
      });
    }

    res.json({
      success: true,
      nacha
    });
  } catch (error) {
    logger.error('Error getting NACHA details', {
      error: error.message,
      nachaId: req.params.nachaId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: 'Failed to get NACHA details'
    });
  }
});

/**
 * GET /api/accounting/nacha/:nachaId/default-send-vendor
 * Returns a suggested vendor for "Send destination" in the Send NACHA modal.
 *
 * Current logic: we use who is being paid in this file (recipients), not the payout/funding account.
 * - For Vendor Payouts: pick the vendor that appears in NACHAPaymentDetails with the largest total amount.
 * - We do not store the funding ACH account on oe.NACHAGenerations, so we cannot trace "payout account → vendor".
 * - If we later persist FundingAchAccountId (or a source like TPA/Vendor) at generation time, we could try
 *   resolving that to a VendorId first (e.g. TPA ACH → VendorTenantTpaServices.VendorId); when the payout
 *   account is not vendor-owned (e.g. TenantPayoutACH, agency ACH), we would have no default from that path.
 * Returns { vendorId: string | null } for pre-selecting the Send destination.
 */
router.get('/:nachaId/default-send-vendor', requireTenantAccess, async (req, res) => {
  try {
    const { nachaId } = req.params;
    const accessCheck = await verifyNACHATenantAccess(nachaId, req);
    if (!accessCheck) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: NACHA file not found or belongs to a different tenant'
      });
    }
    const pool = await getPool();
    const request = pool.request();
    request.input('NACHAId', sql.UniqueIdentifier, nachaId);
    // Recipient-based default: vendor we're paying the most in this file
    const result = await request.query(`
      SELECT TOP 1 d.RecipientEntityId AS VendorId
      FROM oe.NACHAPaymentDetails d
      INNER JOIN oe.NACHAGenerations g ON g.NACHAId = d.NACHAId
      WHERE d.NACHAId = @NACHAId
        AND d.RecipientEntityType = 'Vendor'
        AND d.Amount > 0
      GROUP BY d.RecipientEntityId
      ORDER BY SUM(d.Amount) DESC
    `);
    const vendorId = result.recordset[0]?.VendorId ?? null;
    res.json({
      success: true,
      vendorId: vendorId ? String(vendorId) : null
    });
  } catch (error) {
    logger.error('Error getting default send vendor', { error: error.message, nachaId: req.params.nachaId }, 'NACHA');
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get default vendor'
    });
  }
});

/**
 * GET /api/accounting/nacha/:nachaId/download
 * Download NACHA file
 * Verifies tenant access before allowing download
 */
router.get('/:nachaId/download', requireTenantAccess, async (req, res) => {
  try {
    const { nachaId } = req.params;
    
    // Verify tenant access
    const accessCheck = await verifyNACHATenantAccess(nachaId, req);
    if (!accessCheck) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: NACHA file not found or belongs to a different tenant'
      });
    }
    
    const pool = await getPool();
    const request = pool.request();
    request.input('NACHAId', sql.UniqueIdentifier, nachaId);

    const result = await request.query(`
      SELECT FileName, FileContent
      FROM oe.NACHAGenerations
      WHERE NACHAId = @NACHAId
    `);

    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'NACHA file not found'
      });
    }

    const { FileName, FileContent } = result.recordset[0];

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${FileName}"`);
    res.send(FileContent);
  } catch (error) {
    logger.error('Error downloading NACHA file', {
      error: error.message,
      nachaId: req.params.nachaId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: 'Failed to download NACHA file'
    });
  }
});

/**
 * GET /api/accounting/nacha/:nachaId/line-items
 * Get paginated line items for NACHA details
 * Verifies tenant access before returning line items
 */
router.get('/:nachaId/line-items', requireTenantAccess, async (req, res) => {
  try {
    const { nachaId } = req.params;
    
    // Verify tenant access
    const accessCheck = await verifyNACHATenantAccess(nachaId, req);
    if (!accessCheck) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: NACHA file not found or belongs to a different tenant'
      });
    }
    
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const pool = await getPool();
    const request = pool.request();
    request.input('NACHAId', sql.UniqueIdentifier, nachaId);

    // Get all payment details for this NACHA (we'll group them)
    const result = await request.query(`
      SELECT 
        npd.NACHAPaymentDetailId,
        npd.PaymentId,
        COALESCE(p.InvoiceId, npd.InvoiceId) AS InvoiceId,
        npd.RecipientEntityType,
        npd.RecipientEntityId,
        npd.Amount,
        npd.TierLevel,
        npd.CommissionRuleId,
        npd.ACHAccountId,
        cr.RuleName,
        ach.AccountHolderName as ACHAccountName,
        ach.BankName as ACHBankName,
        -- Get entity name based on type
        CASE 
          WHEN npd.RecipientEntityType = 'Agent' AND u.FirstName IS NOT NULL THEN ISNULL(u.FirstName, '') + ' ' + ISNULL(u.LastName, '')
          WHEN npd.RecipientEntityType = 'Agent' THEN 'Agent ' + CAST(a.AgentId AS VARCHAR(36))
          WHEN npd.RecipientEntityType = 'Agency' THEN ISNULL(ag.AgencyName, 'Agency ' + CAST(ag.AgencyId AS VARCHAR(36)))
          WHEN npd.RecipientEntityType = 'Vendor' THEN ISNULL(v.VendorName, 'Vendor ' + CAST(v.VendorId AS VARCHAR(36)))
          WHEN npd.RecipientEntityType = 'Tenant' THEN ISNULL(t.Name, 'Tenant ' + CAST(t.TenantId AS VARCHAR(36)))
          ELSE 'Unknown'
        END as RecipientName
      FROM oe.NACHAPaymentDetails npd
      LEFT JOIN oe.Payments p ON npd.PaymentId = p.PaymentId
      LEFT JOIN oe.CommissionRules cr ON npd.CommissionRuleId = cr.RuleId
      LEFT JOIN oe.Agents a ON npd.RecipientEntityType = 'Agent' AND npd.RecipientEntityId = a.AgentId
      LEFT JOIN oe.Users u ON a.UserId = u.UserId
      LEFT JOIN oe.Agencies ag ON npd.RecipientEntityType = 'Agency' AND npd.RecipientEntityId = ag.AgencyId
      LEFT JOIN oe.Vendors v ON npd.RecipientEntityType = 'Vendor' AND npd.RecipientEntityId = v.VendorId
      LEFT JOIN oe.Tenants t ON npd.RecipientEntityType = 'Tenant' AND npd.RecipientEntityId = t.TenantId
      LEFT JOIN oe.ACHAccounts ach ON npd.ACHAccountId = ach.ACHAccountId
      -- Phase 6d: include negative debit lines from clawback netting so the UI
      -- can render Debits alongside Credits. Was 'npd.Amount > 0'.
      WHERE npd.NACHAId = @NACHAId AND npd.Amount != 0
      ORDER BY npd.RecipientEntityType, npd.RecipientEntityId, npd.Amount DESC
    `);

    // Get unique recipient count for pagination (grouping by ACHAccount too if present)
    const countResult = await request.query(`
      SELECT COUNT(DISTINCT CONCAT(RecipientEntityType, '_', CAST(RecipientEntityId AS VARCHAR(36)), '_', ISNULL(CAST(ACHAccountId AS VARCHAR(36)), 'none'))) as Total
      FROM oe.NACHAPaymentDetails
      WHERE NACHAId = @NACHAId AND Amount != 0
    `);

    // Convert PascalCase to camelCase for frontend compatibility
    // Group by recipient to show totals
    const groupedItems = {};
    const allItems = result.recordset.map(item => ({
      nachaPaymentDetailId: item.NACHAPaymentDetailId,
      recipientEntityType: item.RecipientEntityType,
      recipientEntityId: item.RecipientEntityId,
      amount: parseFloat(item.Amount) || 0,
      tierLevel: item.TierLevel,
      ruleId: item.CommissionRuleId,
      ruleName: item.RuleName || null,
      recipientName: item.RecipientName || 'Unknown',
      paymentId: item.PaymentId || null,
      invoiceId: item.InvoiceId ? item.InvoiceId.toString() : null,
      achAccountId: item.ACHAccountId,
      achAccountName: item.ACHAccountName,
      achBankName: item.ACHBankName
    }));

    // Group by recipient (entityType + entityId + achAccountId)
    for (const item of allItems) {
      const key = `${item.recipientEntityType}_${item.recipientEntityId}_${item.achAccountId || 'none'}`;
      if (!groupedItems[key]) {
        groupedItems[key] = {
          ...item,
          recipientName: item.recipientName,
          totalAmount: 0,
          grossCredits: 0,
          clawbackTotal: 0,
          paymentCount: 0,
          invoiceCount: 0,
          paymentIds: [],
          invoiceIds: []
        };
      }
      groupedItems[key].totalAmount += item.amount;
      if (item.amount > 0) {
        groupedItems[key].grossCredits += item.amount;
      } else if (item.amount < 0) {
        groupedItems[key].clawbackTotal += Math.abs(item.amount);
      }
      groupedItems[key].paymentCount += 1;
      if (item.paymentId && !groupedItems[key].paymentIds.includes(item.paymentId)) {
        groupedItems[key].paymentIds.push(item.paymentId);
      }
      const invoiceKey = item.invoiceId || item.paymentId || item.nachaPaymentDetailId;
      if (invoiceKey && !groupedItems[key].invoiceIds.includes(invoiceKey)) {
        groupedItems[key].invoiceIds.push(invoiceKey);
      }
    }

    for (const g of Object.values(groupedItems)) {
      g.invoiceCount = g.invoiceIds.length;
    }

    // Vendor / tenant override clawbacks (netted at generation; stored on oe.PayoutClawbacks)
    const payoutClawbackRes = await request.query(`
      SELECT
        pc.RecipientEntityId,
        CASE WHEN pc.PayoutType = N'Vendor' THEN N'Vendor' ELSE N'Tenant' END AS RecipientEntityType,
        SUM(CAST(pc.Amount AS DECIMAL(18, 6)) - CAST(pc.RemainingAmount AS DECIMAL(18, 6))) AS ClawbackApplied
      FROM oe.PayoutClawbacks pc
      WHERE pc.AppliedToNACHAId = @NACHAId
        AND pc.PayoutType IN (N'Vendor', N'TenantOverride')
        AND (CAST(pc.Amount AS DECIMAL(18, 6)) - CAST(pc.RemainingAmount AS DECIMAL(18, 6))) > 0.005
      GROUP BY pc.RecipientEntityId, pc.PayoutType
    `);
    const payoutClawbackByRecipient = new Map();
    for (const row of payoutClawbackRes.recordset || []) {
      const rKey = `${row.RecipientEntityType}_${String(row.RecipientEntityId).toUpperCase()}`;
      payoutClawbackByRecipient.set(
        rKey,
        (payoutClawbackByRecipient.get(rKey) || 0) + (parseFloat(row.ClawbackApplied) || 0)
      );
    }

    const entityNetByRecipient = new Map();
    for (const g of Object.values(groupedItems)) {
      const rKey = `${g.recipientEntityType}_${String(g.recipientEntityId).toUpperCase()}`;
      entityNetByRecipient.set(rKey, (entityNetByRecipient.get(rKey) || 0) + g.totalAmount);
    }

    for (const g of Object.values(groupedItems)) {
      const rKey = `${g.recipientEntityType}_${String(g.recipientEntityId).toUpperCase()}`;
      const payoutClaw = payoutClawbackByRecipient.get(rKey) || 0;
      if (payoutClaw > 0) {
        const entityNet = entityNetByRecipient.get(rKey) || 0;
        const rowNet = g.totalAmount || 0;
        const share = entityNet > 0.005 ? Math.max(0, rowNet) / entityNet : 1;
        g.clawbackTotal += Math.round(payoutClaw * share * 100) / 100;
      }
      g.grossCredits = Math.round((g.grossCredits || 0) * 100) / 100;
      g.clawbackTotal = Math.round((g.clawbackTotal || 0) * 100) / 100;
    }

    // Sort by total amount descending, then apply pagination
    const allGroupedItems = Object.values(groupedItems)
      .sort((a, b) => b.totalAmount - a.totalAmount)
      .map(item => ({
        ...item,
        amount: item.totalAmount,
        clawbackTotal: item.clawbackTotal || 0,
        grossCredits: item.grossCredits > 0 ? item.grossCredits : (item.totalAmount > 0 ? item.totalAmount : 0)
      }));

    // Apply pagination to grouped results
    const lineItems = allGroupedItems.slice(offset, offset + parseInt(limit));

    res.json({
      success: true,
      lineItems,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult.recordset[0].Total,
        totalPages: Math.ceil(countResult.recordset[0].Total / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('Error getting NACHA line items', {
      error: error.message,
      nachaId: req.params.nachaId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: 'Failed to get line items'
    });
  }
});

/**
 * GET /api/accounting/nacha/:nachaId/vendor-payables-info
 * Get list of vendors in this NACHA with format info (for Export Payables modal).
 */
router.get('/:nachaId/vendor-payables-info', requireTenantAccess, async (req, res) => {
  try {
    const { nachaId } = req.params;
    const accessCheck = await verifyNACHATenantAccess(nachaId, req);
    if (!accessCheck) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: NACHA file not found or belongs to a different tenant'
      });
    }
    const pool = await getPool();
    const request = pool.request();
    request.input('NACHAId', sql.UniqueIdentifier, nachaId);

    let result;
    try {
      result = await request.query(`
        SELECT DISTINCT
          npd.RecipientEntityId as VendorId,
          v.VendorName,
          v.PayablesRowTemplate
        FROM oe.NACHAPaymentDetails npd
        INNER JOIN oe.Vendors v ON npd.RecipientEntityId = v.VendorId
        WHERE npd.NACHAId = @NACHAId
          AND npd.RecipientEntityType = 'Vendor'
          AND npd.Amount > 0
        ORDER BY v.VendorName
      `);
    } catch (queryErr) {
      // Fallback if PayablesRowTemplate column doesn't exist (migration not run)
      const msg = (queryErr?.message || '').toLowerCase();
      if (msg.includes('payablesrowtemplate') || msg.includes('invalid column')) {
        result = await pool.request()
          .input('NACHAId', sql.UniqueIdentifier, nachaId)
          .query(`
            SELECT DISTINCT
              npd.RecipientEntityId as VendorId,
              v.VendorName
            FROM oe.NACHAPaymentDetails npd
            INNER JOIN oe.Vendors v ON npd.RecipientEntityId = v.VendorId
            WHERE npd.NACHAId = @NACHAId
              AND npd.RecipientEntityType = 'Vendor'
              AND npd.Amount > 0
            ORDER BY v.VendorName
          `);
        result.recordset = (result.recordset || []).map(r => ({ ...r, PayablesRowTemplate: null }));
      } else {
        throw queryErr;
      }
    }

    const vendors = (result.recordset || []).map(r => ({
      vendorId: r.VendorId ? String(r.VendorId) : null,
      vendorName: r.VendorName || 'Unknown',
      hasCustomFormat: !!(r.PayablesRowTemplate && String(r.PayablesRowTemplate).trim())
    }));
    res.json({ success: true, vendors });
  } catch (error) {
    logger.error('Error getting vendor payables info', { error: error.message, stack: error.stack, nachaId: req.params.nachaId }, 'NACHA');
    res.status(500).json({
      success: false,
      message: 'Failed to get vendor payables info'
    });
  }
});

/**
 * GET /api/accounting/nacha/:nachaId/vendor/:vendorId/payables-export
 * Export payables CSV for a vendor. Returns JSON with csv, total, nachaPayout for reconciliation check.
 */
router.get('/:nachaId/vendor/:vendorId/payables-export', requireTenantAccess, async (req, res) => {
  try {
    const { nachaId, vendorId } = req.params;
    const accessCheck = await verifyNACHATenantAccess(nachaId, req);
    if (!accessCheck) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: NACHA file not found or belongs to a different tenant'
      });
    }

    let rows;
    let paidThroughStart;
    let paidThroughEnd;
    let nachaPayout;
    let nachaSentDate;
    let nachaGeneratedDate;
    let allocationWarnings;
    let reconciliation;
    try {
      ({
        rows,
        paidThroughStart,
        paidThroughEnd,
        nachaPayout,
        nachaSentDate,
        nachaGeneratedDate,
        allocationWarnings,
        reconciliation
      } = await VendorExportService.fetchPayablesRowsForNacha(nachaId, vendorId));
    } catch (err) {
      if (err && err.message === 'NACHA not found') {
        return res.status(404).json({ success: false, message: 'NACHA not found' });
      }
      throw err;
    }

    const vendor = await VendorExportService.getVendorConfig(vendorId);
    const clawbackRows = await VendorExportService.fetchClawbacksForVendorNacha(nachaId, vendorId);
    const {
      csv,
      total,
      contractTotal,
      paidTotal,
      varianceTotal,
      netTotal,
      clawbacksTotal
    } = VendorExportService.formatPayablesCSV(
      rows,
      vendor,
      paidThroughStart,
      paidThroughEnd,
      { clawbackRows, nachaPayoutNet: nachaPayout }
    );
    const clawbacksApplied = Math.abs(clawbacksTotal || 0);

    res.json({
      success: true,
      csv,
      total,
      contractTotal,
      paidTotal,
      varianceTotal,
      netTotal,
      nachaPayout,
      rowCount: rows.length,
      paidThroughStart,
      paidThroughEnd,
      nachaSentDate,
      nachaGeneratedDate,
      clawbacks:
        clawbackRows.length > 0
          ? {
              totalApplied: clawbacksApplied,
              rowCount: clawbackRows.length,
              includedInPayablesCsv: true
            }
          : null,
      allocationWarnings: allocationWarnings || [],
      reconciliation: reconciliation
        ? {
            ...reconciliation,
            clawbacksApplied: clawbacksApplied || reconciliation.clawbacksApplied || 0
          }
        : null
    });
  } catch (error) {
    logger.error('Error exporting vendor payables', {
      error: error.message,
      nachaId: req.params.nachaId,
      vendorId: req.params.vendorId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: 'Failed to export vendor payables'
    });
  }
});

/**
 * GET /api/accounting/nacha/:nachaId/vendor/:vendorId/payables-discrepancies
 * Explain why the payables CSV total != NACHA payout for a vendor.
 * Returns a list of per-NACHAPaymentDetail entries for payments that are in NACHA but missing / refunded
 * from the payables CSV, with primary member info + termination date + reason(s).
 */
router.get('/:nachaId/vendor/:vendorId/payables-discrepancies', requireTenantAccess, async (req, res) => {
  try {
    const { nachaId, vendorId } = req.params;
    const accessCheck = await verifyNACHATenantAccess(nachaId, req);
    if (!accessCheck) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: NACHA file not found or belongs to a different tenant'
      });
    }

    const discrepancies = await VendorExportService.fetchPayablesDiscrepancies(nachaId, vendorId);
    res.json({ success: true, discrepancies });
  } catch (error) {
    logger.error('Error fetching vendor payables discrepancies', {
      error: error.message,
      nachaId: req.params.nachaId,
      vendorId: req.params.vendorId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: 'Failed to fetch vendor payables discrepancies'
    });
  }
});

/**
 * GET /api/accounting/nacha/preview/recipient/:entityType/:entityId/payments
 * Get payment details for a recipient in preview (before NACHA generation)
 * Uses date range and filters by entity
 */
router.get('/preview/recipient/:entityType/:entityId/payments', async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'startDate and endDate query parameters are required'
      });
    }

    const { getPool, sql } = require('../../config/database');
    const pool = await getPool();
    const request = pool.request();
    
    // Convert dates to UTC with proper start/end of day
    const startDateUTC = new Date(startDate);
    startDateUTC.setUTCHours(0, 0, 0, 0);
    
    const endDateUTC = new Date(endDate);
    endDateUTC.setUTCHours(23, 59, 59, 999);

    request.input('EntityId', sql.UniqueIdentifier, entityId);
    request.input('StartDate', sql.DateTime2, startDateUTC);
    request.input('EndDate', sql.DateTime2, endDateUTC);

    const userRoles = getUserRoles(req.user);
    const isSysAdmin = userRoles.includes('SysAdmin');
    const previewTenantId =
      req.query.tenantId && isSysAdmin
        ? String(req.query.tenantId)
        : req.user?.TenantId || req.tenantId || null;
    let vendorPayoutBasis = 'effectiveEnrollment';
    let overridePayoutBasis = 'paymentReceived';
    if (previewTenantId) {
      const tsReq = pool.request();
      tsReq.input('TId', sql.UniqueIdentifier, previewTenantId);
      const tsRes = await tsReq.query(
        'SELECT AdvancedSettings FROM oe.Tenants WHERE TenantId = @TId'
      );
      if (tsRes.recordset?.length) {
        const raw = tsRes.recordset[0].AdvancedSettings;
        const adv = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
        vendorPayoutBasis = adv?.payouts?.vendorBasis || 'effectiveEnrollment';
        overridePayoutBasis = adv?.payouts?.overrideBasis || 'paymentReceived';
      }
    }

    let query = '';
    if (entityType === 'Agent' || entityType === 'Agency') {
      // For agents and agencies, get payments from commissions in the date range
      // Both query from oe.Commissions, but with different WHERE conditions
      const isAgency = entityType === 'Agency';
      const idColumn = isAgency ? 'c.AgencyId' : 'c.AgentId';
      const transactionTypes = isAgency ? "'Commission'" : "'Advance', 'Commission'";
      
      // Build rule join and selects - agencies can also have tiered commission rules
      const ruleJoinClause = `
        LEFT JOIN oe.CommissionRules cr ON (
          c.RuleIds IS NOT NULL 
          AND c.RuleIds != ''
          AND c.RuleIds != '[]'
          AND cr.RuleId = CAST(JSON_VALUE(c.RuleIds, '$[0]') AS UNIQUEIDENTIFIER)
        )`;
      
      // Get agent's or agency's tier level (not the rule's tier level)
      // For agents: use CommissionTierLevel or hierarchy-based TierLevel
      // For agencies: use CommissionTierLevel
      const tierLevelSelect = isAgency 
        ? `, ag.CommissionTierLevel as EntityTierLevel`
        : `, ISNULL(a.CommissionTierLevel, upline.HierarchyTierLevel) as EntityTierLevel`;
      
      // For agents, need OUTER APPLY to get hierarchy-based tier level
      const tierLevelJoin = isAgency 
        ? ''
        : `OUTER APPLY (
          SELECT TOP 1 u.TierLevel as HierarchyTierLevel
          FROM oe.fn_GetAgentUplineForCommission(c.AgentId) u
          WHERE u.AgentId = c.AgentId
        ) upline`;
      
      const ruleSelects = `,
          cr.RuleId as RuleId,
          cr.RuleName as RuleName,
          cr.CommissionType,
          cr.TierLevel as RuleTierLevel${tierLevelSelect}`;
      
      // Eligibility check only for agents (advances) - agencies don't have advances
      // PaymentDate IS NOT NULL applies to both
      const eligibilityCheck = isAgency ? `
          AND p.PaymentDate IS NOT NULL` : `
          AND p.PaymentDate IS NOT NULL
          AND (
            (c.OriginalCommissionId IS NULL AND CAST(p.PaymentDate AS DATE) <= CAST(@EndDate AS DATE))
            OR
            (c.OriginalCommissionId IS NOT NULL AND 
             EXISTS (
               SELECT 1 
               FROM oe.Commissions adv 
               WHERE adv.CommissionId = c.OriginalCommissionId 
                 AND adv.AdvanceBalance = 0
             ))
          )`;
      
      query = `
        SELECT DISTINCT
          p.PaymentId,
          inv.InvoiceId as InvoiceId,
          'Payment' as FundingSource,
          p.Amount as PaymentAmount,
          p.PaymentDate,
          p.CreatedDate as PaymentCreatedDate,
          -- Invoice-sourced payouts: prefer invoice breakdowns with payment fallback
          COALESCE(inv.Commission, p.Commission) as CommissionPool,
          COALESCE(inv.NetRate, p.NetRate) as NetRate,
          COALESCE(inv.OverrideRate, p.OverrideRate) as OverrideRate,
          COALESCE(inv.ProductCommissions, p.ProductCommissions) as ProductCommissions,
          COALESCE(inv.ProductVendorAmounts, p.ProductVendorAmounts) as ProductVendorAmounts,
          COALESCE(inv.ProductOwnerAmounts, p.ProductOwnerAmounts) as ProductOwnerAmounts,
          -- Household-anchored member resolution. See vendor branch for the
          -- rationale: enrollments are 1:N per household so a single
          -- canonical EnrollmentId is wrong for naming the recipient.
          COALESCE(
            u.FirstName + ' ' + u.LastName,
            hhMember.FirstName + ' ' + hhMember.LastName,
            g.Name
          ) as MemberName,
          COALESCE(m.MemberId, hhMember.MemberId) as MemberId,
          p.GroupId,
          g.Name as GroupName,
          p.AgentId as SellingAgentId,
          sellingAgentUser.FirstName + ' ' + sellingAgentUser.LastName as SellingAgentName,
          c.Amount as CommissionAmount,
          c.RuleIds,
          -- Get product tier (EE, ES, EC, EF) from member's Tier field
          (SELECT TOP 1 m2.Tier
           FROM oe.Enrollments e2
           INNER JOIN oe.Members m2 ON e2.MemberId = m2.MemberId
           WHERE (e2.EnrollmentId = p.EnrollmentId 
                  OR e2.HouseholdId = p.HouseholdId 
                  OR e2.GroupId = p.GroupId)
             AND e2.EffectiveDate <= p.PaymentDate
             AND (e2.TerminationDate IS NULL OR e2.TerminationDate > p.PaymentDate)
             AND m2.RelationshipType = 'P'
           ORDER BY CASE WHEN e2.EnrollmentId = p.EnrollmentId THEN 1 ELSE 2 END) as ProductTier${ruleSelects}
        FROM oe.Commissions c
        INNER JOIN oe.Payments p ON c.PaymentId = p.PaymentId
        LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
        LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
        LEFT JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Groups g ON p.GroupId = g.GroupId
        LEFT JOIN oe.Agents sellingAgent ON p.AgentId = sellingAgent.AgentId
        LEFT JOIN oe.Users sellingAgentUser ON sellingAgent.UserId = sellingAgentUser.UserId
        LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
        -- Household-anchored primary member fallback. See vendor branch for
        -- why enrollment is the wrong primary anchor.
        OUTER APPLY (
          SELECT TOP 1
            hm.MemberId,
            hu.FirstName,
            hu.LastName
          FROM oe.Members hm
          LEFT JOIN oe.Users hu ON hm.UserId = hu.UserId
          WHERE hm.HouseholdId = COALESCE(p.HouseholdId, e.HouseholdId, inv.HouseholdId)
            AND COALESCE(p.HouseholdId, e.HouseholdId, inv.HouseholdId) IS NOT NULL
            AND hm.RelationshipType = 'P'
          ORDER BY hm.CreatedDate ASC
        ) hhMember
        ${isAgency 
          ? 'LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId'
          : `LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
        ${tierLevelJoin}`
        }${ruleJoinClause}
        WHERE ${idColumn} = @EntityId
          AND c.Status = 'Pending'
          AND c.TransactionType IN (${transactionTypes})
          AND c.Amount > 0
          AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
          -- Agent commissions: modal list matches getEligibleCommissions — DueDate
          -- when invoice-linked and Paid; PaymentDate when unlinked.
          AND ${agentCommissionDueWindowSql()}
          -- Funding gate: only payments whose linked invoice is fully Paid
          -- (or unlinked legacy rows) qualify, mirroring getUnpaidPayments.
          AND ${fundingGateSql()}${eligibilityCheck}
        ORDER BY p.PaymentDate DESC, p.Amount DESC
      `;
    } else if (entityType === 'Vendor') {
      // For vendors, get payments where vendor gets NetRate
      // Handle both individual payments (EnrollmentId) and group payments (GroupId)
      query = `
        SELECT DISTINCT
          p.PaymentId,
          inv.InvoiceId as InvoiceId,
          'Payment' as FundingSource,
          p.Amount as PaymentAmount,
          p.PaymentDate,
          p.CreatedDate as PaymentCreatedDate,
          -- Invoice-sourced payouts: prefer invoice breakdowns with payment fallback
          COALESCE(inv.NetRate, p.NetRate) as VendorPayout,
          ISNULL(paid.PaidAmount, 0) as VendorAlreadyPaid,
          COALESCE(inv.Commission, p.Commission) as CommissionPool,
          COALESCE(inv.OverrideRate, p.OverrideRate) as OverrideRate,
          COALESCE(inv.ProductCommissions, p.ProductCommissions) as ProductCommissions,
          COALESCE(inv.ProductVendorAmounts, p.ProductVendorAmounts) as ProductVendorAmounts,
          COALESCE(inv.ProductOwnerAmounts, p.ProductOwnerAmounts) as ProductOwnerAmounts,
          -- Member name resolution chain:
          --   1) Enrollment -> Member -> User (most accurate)
          --   2) Household -> primary Member -> User (covers HouseholdId-only payments)
          --   3) Group name (group billing)
          -- Without #2, household-level payments with no specific EnrollmentId
          -- and no GroupId render as "Unknown" in the modal even though the
          -- household exists.
          COALESCE(
            u.FirstName + ' ' + u.LastName,
            hhMember.FirstName + ' ' + hhMember.LastName,
            g.Name
          ) as MemberName,
          COALESCE(m.MemberId, hhMember.MemberId) as MemberId,
          p.GroupId,
          g.Name as GroupName,
          -- Get selling agent name
          sellingAgentUser.FirstName + ' ' + sellingAgentUser.LastName as SellingAgentName,
          -- Get product owner/tenant name
          pr.ProductOwnerId,
          t.Name as TenantName,
          -- Get product tier (EE, ES, EC, EF) from member's Tier field
          (SELECT TOP 1 m2.Tier
           FROM oe.Enrollments e2
           INNER JOIN oe.Members m2 ON e2.MemberId = m2.MemberId
           WHERE (e2.EnrollmentId = p.EnrollmentId 
                  OR (p.HouseholdId IS NOT NULL AND e2.HouseholdId = p.HouseholdId)
                  OR (p.GroupId IS NOT NULL AND m2.GroupId = p.GroupId))
             AND e2.EffectiveDate <= GETUTCDATE()
             AND (e2.TerminationDate IS NULL OR e2.TerminationDate > GETUTCDATE())
             AND m2.RelationshipType = 'P'
           ORDER BY CASE WHEN e2.EnrollmentId = p.EnrollmentId THEN 1 
                         WHEN p.HouseholdId IS NOT NULL AND e2.HouseholdId = p.HouseholdId THEN 2
                         ELSE 3 END) as ProductTier
        FROM oe.Payments p
        LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
        LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
        LEFT JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Groups g ON p.GroupId = g.GroupId
        -- For individual payments, get product from enrollment
        -- For group payments, check if any product in the group matches the vendor
        LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
        -- Tenant table for the t.Name TenantName select. The original query referenced
        -- t.Name without any JOIN, which caused the entire query to throw silently and
        -- return zero rows -- that's the root cause of the empty vendor payment-details
        -- modal even though the preview total showed a non-zero amount.
        LEFT JOIN oe.Tenants t ON pr.ProductOwnerId = t.TenantId
        LEFT JOIN oe.Agents sellingAgent ON p.AgentId = sellingAgent.AgentId
        LEFT JOIN oe.Users sellingAgentUser ON sellingAgent.UserId = sellingAgentUser.UserId
        -- Invoice-sourced payouts: prefer invoice breakdowns (COALESCE fallback to p.X)
        LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
        -- Household-based primary member fallback. Used when the payment has
        -- no EnrollmentId / no GroupId (e.g., credit-funded synthetic payments
        -- or older household-level rows). Without this we render "Unknown"
        -- for a row that actually has a perfectly resolvable household.
        OUTER APPLY (
          SELECT TOP 1
            hm.MemberId,
            hu.FirstName,
            hu.LastName
          FROM oe.Members hm
          LEFT JOIN oe.Users hu ON hm.UserId = hu.UserId
          WHERE hm.HouseholdId = COALESCE(p.HouseholdId, e.HouseholdId, inv.HouseholdId)
            AND COALESCE(p.HouseholdId, e.HouseholdId, inv.HouseholdId) IS NOT NULL
            AND hm.RelationshipType = 'P'
          ORDER BY hm.CreatedDate ASC
        ) hhMember
        -- If this payment includes this vendor in ProductVendorAmounts (multi-vendor cases),
        -- find the vendor's product owner/tenant. Uses the invoice-sourced snapshot first.
        OUTER APPLY (
          SELECT TOP 1 prx.ProductOwnerId as VendorProductOwnerId
          FROM (
            -- array format
            SELECT j1.ProductId as ProductId
            FROM OPENJSON(COALESCE(inv.ProductVendorAmounts, p.ProductVendorAmounts))
              WITH (ProductId uniqueidentifier '$.ProductId') j1

            UNION ALL

            -- object format
            SELECT TRY_CONVERT(uniqueidentifier, j2.[key]) as ProductId
            FROM OPENJSON(COALESCE(inv.ProductVendorAmounts, p.ProductVendorAmounts)) j2
          ) j
          INNER JOIN oe.Products prx ON prx.ProductId = j.ProductId
          WHERE prx.VendorId = @EntityId
          ORDER BY prx.CreatedDate ASC
        ) vendorPO
        -- Already-paid amounts for THIS vendor (from Sent Vendor NACHA generations)
        LEFT JOIN (
          SELECT 
            npd.PaymentId,
            SUM(npd.Amount) as PaidAmount
          FROM oe.NACHAPaymentDetails npd
          INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
          WHERE npd.RecipientEntityType = 'Vendor'
            AND npd.RecipientEntityId = @EntityId
            AND ng.Status = 'Sent'
            AND ng.PayoutType = 'Vendor Payouts'
          GROUP BY npd.PaymentId
        ) paid ON paid.PaymentId = p.PaymentId
        WHERE (
          -- Individual payment: product from enrollment matches vendor
          (p.EnrollmentId IS NOT NULL AND pr.VendorId = @EntityId)
          OR
          -- Group payment: check if any product in the group matches vendor
          (p.GroupId IS NOT NULL AND EXISTS (
            SELECT 1
            FROM oe.Enrollments e2
            INNER JOIN oe.Members m2 ON e2.MemberId = m2.MemberId
            INNER JOIN oe.Products pr2 ON e2.ProductId = pr2.ProductId
            WHERE m2.GroupId = p.GroupId
              AND e2.EffectiveDate <= GETUTCDATE()
              AND (e2.TerminationDate IS NULL OR e2.TerminationDate > GETUTCDATE())
              AND pr2.VendorId = @EntityId
          ))
          OR
          -- Multi-vendor payment: ProductVendorAmounts includes products for this vendor
          (vendorPO.VendorProductOwnerId IS NOT NULL)
        )
          AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
          -- Use invoice-billing-period-aware eligibility so the modal list
          -- matches preview totals. NOTE: we intentionally do NOT exclude on
          -- p.NACHAId here -- the preview doesn't either; instead the modal
          -- subtracts already-paid-via-Sent-NACHA via the "paid" CTE above
          -- (paid.PaidAmount feeds into vendorAlreadyPaid).
          AND ${paymentInWindowSql({ payoutBasis: vendorPayoutBasis })}
        ORDER BY p.PaymentDate DESC, p.Amount DESC
      `;
    } else if (entityType === 'Tenant') {
      // For product owners/tenants, get payments where tenant gets OverrideRate + overflow
      // Handle both individual payments (EnrollmentId) and group payments (GroupId)
      query = `
        SELECT DISTINCT
          p.PaymentId,
          inv.InvoiceId as InvoiceId,
          'Payment' as FundingSource,
          p.Amount as PaymentAmount,
          p.PaymentDate,
          p.CreatedDate as PaymentCreatedDate,
          -- Invoice-sourced payouts: prefer invoice breakdowns with payment fallback
          COALESCE(inv.OverrideRate, p.OverrideRate) as OverridePayout,
          COALESCE(inv.Commission, p.Commission) as CommissionPool,
          COALESCE(inv.NetRate, p.NetRate) as NetRate,
          COALESCE(inv.ProductCommissions, p.ProductCommissions) as ProductCommissions,
          COALESCE(inv.ProductVendorAmounts, p.ProductVendorAmounts) as ProductVendorAmounts,
          COALESCE(inv.ProductOwnerAmounts, p.ProductOwnerAmounts) as ProductOwnerAmounts,
          -- Member name resolution: household-anchored fallback so we never
          -- show "Unknown" for a payment whose EnrollmentId is null but whose
          -- household resolves cleanly. Enrollment-based lookup is wrong as
          -- a primary anchor anyway -- one payment can cover ~20 enrollments
          -- across a single household.
          COALESCE(
            u.FirstName + ' ' + u.LastName,
            hhMember.FirstName + ' ' + hhMember.LastName,
            g.Name
          ) as MemberName,
          COALESCE(m.MemberId, hhMember.MemberId) as MemberId,
          p.GroupId,
          g.Name as GroupName,
          -- Get selling agent name
          sellingAgentUser.FirstName + ' ' + sellingAgentUser.LastName as SellingAgentName,
          -- Calculate overflow (this is simplified - actual overflow comes from commission calculation)
          (p.Amount
            - COALESCE(inv.NetRate, p.NetRate)
            - COALESCE(inv.OverrideRate, p.OverrideRate)
            - COALESCE(inv.Commission, p.Commission)
            - ISNULL(COALESCE(inv.SystemFees, p.SystemFees), 0)) as OverflowAmount,
          -- Get product tier (EE, ES, EC, EF) from member's Tier field
          (SELECT TOP 1 m2.Tier
           FROM oe.Enrollments e2
           INNER JOIN oe.Members m2 ON e2.MemberId = m2.MemberId
           WHERE (e2.EnrollmentId = p.EnrollmentId 
                  OR (p.HouseholdId IS NOT NULL AND e2.HouseholdId = p.HouseholdId)
                  OR (p.GroupId IS NOT NULL AND m2.GroupId = p.GroupId))
             AND e2.EffectiveDate <= GETUTCDATE()
             AND (e2.TerminationDate IS NULL OR e2.TerminationDate > GETUTCDATE())
             AND m2.RelationshipType = 'P'
           ORDER BY CASE WHEN e2.EnrollmentId = p.EnrollmentId THEN 1 
                         WHEN p.HouseholdId IS NOT NULL AND e2.HouseholdId = p.HouseholdId THEN 2
                         ELSE 3 END) as ProductTier
        FROM oe.Payments p
        LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
        LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
        LEFT JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Groups g ON p.GroupId = g.GroupId
        -- For individual payments, get product from enrollment
        -- For group payments, check if any product in the group matches the product owner
        LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
        LEFT JOIN oe.Agents sellingAgent ON p.AgentId = sellingAgent.AgentId
        LEFT JOIN oe.Users sellingAgentUser ON sellingAgent.UserId = sellingAgentUser.UserId
        -- Invoice-sourced payouts: prefer invoice breakdowns (COALESCE fallback to p.X)
        LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
        -- Household-anchored primary member fallback. See vendor branch above
        -- for the rationale: payment / invoice rows aggregate many enrollments,
        -- so we resolve the household first and then the household's primary
        -- member, instead of trusting one canonical EnrollmentId.
        OUTER APPLY (
          SELECT TOP 1
            hm.MemberId,
            hu.FirstName,
            hu.LastName
          FROM oe.Members hm
          LEFT JOIN oe.Users hu ON hm.UserId = hu.UserId
          WHERE hm.HouseholdId = COALESCE(p.HouseholdId, e.HouseholdId, inv.HouseholdId)
            AND COALESCE(p.HouseholdId, e.HouseholdId, inv.HouseholdId) IS NOT NULL
            AND hm.RelationshipType = 'P'
          ORDER BY hm.CreatedDate ASC
        ) hhMember
        WHERE (
          -- Individual payment: product from enrollment matches product owner
          (p.EnrollmentId IS NOT NULL AND pr.ProductOwnerId = @EntityId)
          OR
          -- Group payment: check if any product in the group matches product owner
          (p.GroupId IS NOT NULL AND EXISTS (
            SELECT 1
            FROM oe.Enrollments e2
            INNER JOIN oe.Members m2 ON e2.MemberId = m2.MemberId
            INNER JOIN oe.Products pr2 ON e2.ProductId = pr2.ProductId
            WHERE m2.GroupId = p.GroupId
              AND e2.EffectiveDate <= GETUTCDATE()
              AND (e2.TerminationDate IS NULL OR e2.TerminationDate > GETUTCDATE())
              AND pr2.ProductOwnerId = @EntityId
          ))
        )
          AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
          -- Match preview eligibility window (billing-period-aware) and apply
          -- the funding gate. See vendor branch comment for why NACHAId is
          -- not used to exclude here.
          AND ${paymentInWindowSql({ payoutBasis: overridePayoutBasis })}
          AND ${fundingGateSql()}
        ORDER BY p.PaymentDate DESC, p.Amount DESC
      `;
    } else {
      return res.status(400).json({
        success: false,
        message: `Payment preview for entity type '${entityType}' not yet implemented`
      });
    }

    logger.info('Preview recipient payments query', {
      entityType,
      entityId,
      startDate,
      endDate,
      queryLength: query.length
    }, 'NACHA');

    const result = await request.query(query);

    logger.info('Preview recipient payments query result', {
      entityType,
      entityId,
      recordCount: result.recordset.length
    }, 'NACHA');

    // Supplemental credit-funded (invoice-anchored, no oe.Payments row) rows
    // Mirrors getUnpaidPayments invoice branch so the details modal stays consistent
    // with the summary numbers when credits paid invoices.
    let creditRecords = [];
    try {
      const creditReq = pool.request();
      creditReq.input('EntityIdC', sql.UniqueIdentifier, entityId);
      creditReq.input('StartDateC', sql.DateTime2, startDateUTC);
      creditReq.input('EndDateC', sql.DateTime2, endDateUTC);
      creditReq.input('StartDate', sql.DateTime2, startDateUTC);
      creditReq.input('EndDate', sql.DateTime2, endDateUTC);

      let creditQuery = '';
      if (entityType === 'Agent' || entityType === 'Agency') {
        const isAgency = entityType === 'Agency';
        const idColumn = isAgency ? 'c.AgencyId' : 'c.AgentId';
        const transactionTypes = isAgency ? "'Commission'" : "'Advance', 'Commission'";
        creditQuery = `
          SELECT DISTINCT
            CAST(NULL AS UNIQUEIDENTIFIER) AS PaymentId,
            inv.InvoiceId AS InvoiceId,
            'Credit' AS FundingSource,
            inv.TotalAmount AS PaymentAmount,
            inv.InvoiceDate AS PaymentDate,
            inv.CreatedDate AS PaymentCreatedDate,
            inv.Commission AS CommissionPool,
            inv.NetRate AS NetRate,
            inv.OverrideRate AS OverrideRate,
            inv.ProductCommissions AS ProductCommissions,
            inv.ProductVendorAmounts AS ProductVendorAmounts,
            inv.ProductOwnerAmounts AS ProductOwnerAmounts,
            COALESCE(u.FirstName + ' ' + u.LastName, g.Name) AS MemberName,
            m.MemberId,
            inv.GroupId,
            g.Name AS GroupName,
            sellAgt.SellingAgentId,
            sellAgtUser.FirstName + ' ' + sellAgtUser.LastName AS SellingAgentName,
            c.Amount AS CommissionAmount,
            c.RuleIds,
            CAST(NULL AS NVARCHAR(10)) AS ProductTier,
            CAST(NULL AS UNIQUEIDENTIFIER) AS RuleId,
            CAST(NULL AS NVARCHAR(255)) AS RuleName,
            CAST(NULL AS NVARCHAR(50)) AS CommissionType,
            CAST(NULL AS INT) AS RuleTierLevel,
            CAST(NULL AS INT) AS EntityTierLevel
          FROM oe.Commissions c
          INNER JOIN oe.Invoices inv ON c.InvoiceId = inv.InvoiceId
          -- Resolve the household's primary member directly from oe.Members.
          -- oe.Households is not a real table in this schema; the previous
          -- JOIN through it caused the entire credit-branch SELECT to throw
          -- "Invalid object name 'oe.Households'", which the surrounding
          -- try/catch swallowed -- silently dropping every credit-funded
          -- invoice from the modal and producing the modal-vs-NACHA gap.
          LEFT JOIN oe.Members m ON m.HouseholdId = inv.HouseholdId AND m.RelationshipType = 'P'
          LEFT JOIN oe.Users u ON m.UserId = u.UserId
          LEFT JOIN oe.Groups g ON inv.GroupId = g.GroupId
          OUTER APPLY (
            SELECT TOP 1 e.AgentId AS SellingAgentId
            FROM oe.Enrollments e
            LEFT JOIN oe.Members em ON e.MemberId = em.MemberId
            WHERE (inv.HouseholdId IS NOT NULL AND e.HouseholdId = inv.HouseholdId AND em.RelationshipType = 'P')
              OR (inv.GroupId IS NOT NULL AND em.GroupId = inv.GroupId AND em.RelationshipType = 'P')
            ORDER BY e.CreatedDate ASC
          ) sellAgt
          LEFT JOIN oe.Agents sellAgtAgent ON sellAgt.SellingAgentId = sellAgtAgent.AgentId
          LEFT JOIN oe.Users sellAgtUser ON sellAgtAgent.UserId = sellAgtUser.UserId
          WHERE ${idColumn} = @EntityIdC
            AND c.Status = 'Pending'
            AND c.TransactionType IN (${transactionTypes})
            AND c.Amount > 0
            AND c.PaymentId IS NULL
            AND c.InvoiceId IS NOT NULL
            AND inv.Status = 'Paid'
            AND CAST(COALESCE(inv.DueDate, inv.BillingPeriodStart, inv.CreatedDate) AS DATE) >= CAST(@StartDateC AS DATE)
            AND CAST(COALESCE(inv.DueDate, inv.BillingPeriodStart, inv.CreatedDate) AS DATE) <= CAST(@EndDateC AS DATE)
        `;
      } else if (entityType === 'Vendor') {
        creditQuery = `
          SELECT DISTINCT
            CAST(NULL AS UNIQUEIDENTIFIER) AS PaymentId,
            inv.InvoiceId AS InvoiceId,
            'Credit' AS FundingSource,
            inv.TotalAmount AS PaymentAmount,
            inv.InvoiceDate AS PaymentDate,
            inv.CreatedDate AS PaymentCreatedDate,
            inv.NetRate AS VendorPayout,
            CAST(0 AS DECIMAL(18,4)) AS VendorAlreadyPaid,
            inv.Commission AS CommissionPool,
            inv.OverrideRate AS OverrideRate,
            inv.ProductCommissions AS ProductCommissions,
            inv.ProductVendorAmounts AS ProductVendorAmounts,
            inv.ProductOwnerAmounts AS ProductOwnerAmounts,
            COALESCE(u.FirstName + ' ' + u.LastName, g.Name) AS MemberName,
            m.MemberId,
            inv.GroupId,
            g.Name AS GroupName,
            CAST(NULL AS NVARCHAR(255)) AS SellingAgentName,
            CAST(NULL AS UNIQUEIDENTIFIER) AS ProductOwnerId,
            CAST(NULL AS NVARCHAR(255)) AS TenantName,
            CAST(NULL AS NVARCHAR(10)) AS ProductTier
          FROM oe.Invoices inv
          -- oe.Households is not a real table in this schema; resolving the
          -- household primary member through it caused the entire credit
          -- branch to throw 'Invalid object name oe.Households', the
          -- surrounding catch swallowed it, and credit-funded invoices
          -- silently disappeared from the modal -- producing the modal vs
          -- NACHA total mismatch (e.g., $1,227 modal vs $1,605 NACHA on
          -- ShareWELL when Brian Schoening's $378 credit invoice was the
          -- only credit-funded contributor).
          LEFT JOIN oe.Members m ON m.HouseholdId = inv.HouseholdId AND m.RelationshipType = 'P'
          LEFT JOIN oe.Users u ON m.UserId = u.UserId
          LEFT JOIN oe.Groups g ON inv.GroupId = g.GroupId
          WHERE inv.Status = N'${PAID_INVOICE_STATUS}'
            AND NOT EXISTS (SELECT 1 FROM oe.Payments p WHERE p.InvoiceId = inv.InvoiceId AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL})
            AND (${invoicePayoutWindowSql({ invAlias: 'inv', payoutBasis: vendorPayoutBasis }).replace(/\s+/g, ' ')})
            -- Vendor scoping. Surface the invoice if any of the snapshotted
            -- breakdown JSONs (vendor amounts OR commissions OR owner amounts)
            -- references a product owned by this vendor. The post-processing
            -- step reads ProductVendorAmounts to compute the per-vendor figure
            -- and drops rows whose vendor share is $0, so we don't risk
            -- over-counting -- we just stop dropping invoices that have
            -- a missing/empty ProductVendorAmounts snapshot but still belong
            -- to this vendor (which was the cause of the modal showing a
            -- smaller total than the NACHA preview).
            AND EXISTS (
              SELECT 1
              FROM oe.Products prx
              WHERE prx.VendorId = @EntityIdC
                AND (
                  (ISJSON(inv.ProductVendorAmounts) = 1 AND EXISTS (
                    SELECT 1 FROM (
                      SELECT j1.ProductId AS ProductId
                      FROM OPENJSON(inv.ProductVendorAmounts) WITH (ProductId UNIQUEIDENTIFIER '$.ProductId') j1
                      UNION ALL
                      SELECT TRY_CONVERT(UNIQUEIDENTIFIER, j2.[key]) AS ProductId
                      FROM OPENJSON(inv.ProductVendorAmounts) j2
                    ) jv WHERE jv.ProductId = prx.ProductId
                  ))
                  OR
                  (ISJSON(inv.ProductCommissions) = 1 AND EXISTS (
                    SELECT 1 FROM (
                      SELECT j3.ProductId AS ProductId
                      FROM OPENJSON(inv.ProductCommissions) WITH (ProductId UNIQUEIDENTIFIER '$.ProductId') j3
                      UNION ALL
                      SELECT TRY_CONVERT(UNIQUEIDENTIFIER, j4.[key]) AS ProductId
                      FROM OPENJSON(inv.ProductCommissions) j4
                    ) jc WHERE jc.ProductId = prx.ProductId
                  ))
                )
            )
        `;
      } else if (entityType === 'Tenant') {
        creditQuery = `
          SELECT DISTINCT
            CAST(NULL AS UNIQUEIDENTIFIER) AS PaymentId,
            inv.InvoiceId AS InvoiceId,
            'Credit' AS FundingSource,
            inv.TotalAmount AS PaymentAmount,
            inv.InvoiceDate AS PaymentDate,
            inv.CreatedDate AS PaymentCreatedDate,
            inv.OverrideRate AS OverridePayout,
            inv.Commission AS CommissionPool,
            inv.NetRate AS NetRate,
            inv.ProductCommissions AS ProductCommissions,
            inv.ProductVendorAmounts AS ProductVendorAmounts,
            inv.ProductOwnerAmounts AS ProductOwnerAmounts,
            COALESCE(u.FirstName + ' ' + u.LastName, g.Name) AS MemberName,
            m.MemberId,
            inv.GroupId,
            g.Name AS GroupName,
            CAST(NULL AS NVARCHAR(255)) AS SellingAgentName,
            (inv.TotalAmount - inv.NetRate - inv.OverrideRate - inv.Commission - ISNULL(inv.SystemFees, 0)) AS OverflowAmount,
            CAST(NULL AS NVARCHAR(10)) AS ProductTier
          FROM oe.Invoices inv
          -- See note on Vendor credit branch: oe.Households is not a real
          -- table; resolve household primary member directly via
          -- oe.Members.HouseholdId.
          LEFT JOIN oe.Members m ON m.HouseholdId = inv.HouseholdId AND m.RelationshipType = 'P'
          LEFT JOIN oe.Users u ON m.UserId = u.UserId
          LEFT JOIN oe.Groups g ON inv.GroupId = g.GroupId
          WHERE inv.Status = N'${PAID_INVOICE_STATUS}'
            AND NOT EXISTS (SELECT 1 FROM oe.Payments p WHERE p.InvoiceId = inv.InvoiceId AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL})
            AND (${invoicePayoutWindowSql({ invAlias: 'inv', payoutBasis: overridePayoutBasis }).replace(/\s+/g, ' ')})
            AND ISJSON(inv.ProductOwnerAmounts) = 1
            AND EXISTS (
              SELECT 1
              FROM (
                SELECT j1.ProductId AS ProductId
                FROM OPENJSON(inv.ProductOwnerAmounts) WITH (ProductId UNIQUEIDENTIFIER '$.ProductId') j1
                UNION ALL
                SELECT TRY_CONVERT(UNIQUEIDENTIFIER, j2.[key]) AS ProductId
                FROM OPENJSON(inv.ProductOwnerAmounts) j2
              ) j
              INNER JOIN oe.Products prx ON prx.ProductId = j.ProductId
              WHERE prx.ProductOwnerId = @EntityIdC
            )
        `;
      }

      if (creditQuery) {
        const creditRes = await creditReq.query(creditQuery);
        creditRecords = creditRes.recordset || [];
        logger.info('Preview recipient credit-funded supplemental rows', {
          entityType,
          entityId,
          recordCount: creditRecords.length,
          // First few invoice IDs surface the missing-credit-funded case fast
          // when the modal total disagrees with the NACHA preview total.
          sampleInvoiceIds: creditRecords.slice(0, 5).map(r => r.InvoiceId)
        }, 'NACHA');
      }
    } catch (creditErr) {
      // Surface the SQL error message so silent JSON / column errors don't
      // hide the modal undercount behind a generic warning.
      logger.warn('Credit-funded supplemental query failed', {
        entityType,
        entityId,
        error: creditErr.message,
        stack: creditErr.stack
      }, 'NACHA');
    }

    const allRecords = [...result.recordset, ...creditRecords];

    const paymentDetails = (await Promise.all(allRecords.map(async (item) => {
      // Use GroupName if available (for group payments), otherwise use MemberName
      const displayName = item.GroupName || item.MemberName || 'Unknown';
      
      // Calculate unique household count for this payment
      let uniqueHouseholdCount = 0;
      if (item.PaymentId) {
        try {
          const householdCountRequest = pool.request();
          householdCountRequest.input('PaymentId', sql.UniqueIdentifier, item.PaymentId);
          
          const householdCountQuery = `
            SELECT COUNT(DISTINCT m.HouseholdId) as HouseholdCount
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE (
              e.EnrollmentId IN (SELECT EnrollmentId FROM oe.Payments WHERE PaymentId = @PaymentId AND EnrollmentId IS NOT NULL)
              OR e.HouseholdId IN (SELECT HouseholdId FROM oe.Payments WHERE PaymentId = @PaymentId AND HouseholdId IS NOT NULL)
              OR m.GroupId IN (SELECT GroupId FROM oe.Payments WHERE PaymentId = @PaymentId AND GroupId IS NOT NULL)
            )
              AND e.EffectiveDate <= (SELECT PaymentDate FROM oe.Payments WHERE PaymentId = @PaymentId)
              AND (e.TerminationDate IS NULL OR e.TerminationDate > (SELECT PaymentDate FROM oe.Payments WHERE PaymentId = @PaymentId))
              AND m.RelationshipType = 'P'
          `;
          const householdCountResult = await householdCountRequest.query(householdCountQuery);
          uniqueHouseholdCount = householdCountResult.recordset[0]?.HouseholdCount || 0;
        } catch (error) {
          logger.warn('Error calculating unique household count', { paymentId: item.PaymentId, error: error.message }, 'NACHA');
        }
      } else if (item.InvoiceId) {
        // Credit-funded row anchored on invoice; count households via invoice scope
        try {
          const hhReq = pool.request();
          hhReq.input('InvoiceIdHH', sql.UniqueIdentifier, item.InvoiceId);
          const hhQuery = `
            SELECT COUNT(DISTINCT m.HouseholdId) AS HouseholdCount
            FROM oe.Invoices inv
            LEFT JOIN oe.Enrollments e
              ON (inv.GroupId IS NOT NULL AND m.GroupId = inv.GroupId)
              OR (inv.GroupId IS NULL AND e.HouseholdId = inv.HouseholdId)
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE inv.InvoiceId = @InvoiceIdHH
              AND m.RelationshipType = 'P'
              AND (
                inv.BillingPeriodStart IS NULL
                OR (
                  e.EffectiveDate <= inv.BillingPeriodEnd
                  AND (e.TerminationDate IS NULL OR e.TerminationDate >= inv.BillingPeriodStart)
                )
              )
          `;
          const hhRes = await hhReq.query(hhQuery);
          uniqueHouseholdCount = hhRes.recordset[0]?.HouseholdCount || 0;
        } catch (error) {
          logger.warn('Error calculating credit-funded household count', { invoiceId: item.InvoiceId, error: error.message }, 'NACHA');
        }
      }
      
      const base = {
        paymentId: item.PaymentId,
        invoiceId: item.InvoiceId || null,
        fundingSource: item.FundingSource || 'Payment',
        paymentAmount: parseFloat(item.PaymentAmount) || 0,
        paymentDate: item.PaymentDate,
        paymentCreatedDate: item.PaymentCreatedDate,
        productTier: item.ProductTier || null, // EE, ES, EC, or EF
        memberName: displayName,
        memberId: item.MemberId,
        groupId: item.GroupId,
        groupName: item.GroupName,
        sellingAgentId: item.SellingAgentId ? item.SellingAgentId.toString() : null,
        sellingAgentName: item.SellingAgentName || null,
        productCommissions: item.ProductCommissions || null, // JSON string
        productVendorAmounts: item.ProductVendorAmounts || null, // JSON string
        productOwnerAmounts: item.ProductOwnerAmounts || null, // JSON string
        uniqueHouseholdCount: uniqueHouseholdCount,
        // Vendors: already-paid amount for THIS vendor/payment (from Sent Vendor NACHA generations)
        vendorAlreadyPaid: parseFloat(item.VendorAlreadyPaid) || 0
      };
      
      if (entityType === 'Agent' || entityType === 'Agency') {
        const isAgency = entityType === 'Agency';
        // Parse RuleIds JSON array
        let ruleIds = [];
        try {
          if (item.RuleIds) {
            ruleIds = typeof item.RuleIds === 'string' 
              ? JSON.parse(item.RuleIds) 
              : item.RuleIds;
          }
        } catch (error) {
          // Ignore parse errors
        }
        
        if (isAgency) {
          // Agencies can receive both tiered commissions (from tiered rules) and overflow
          // If RuleIds is empty or null, it's overflow; otherwise it's from tiered rules
          const hasRules = Array.isArray(ruleIds) && ruleIds.length > 0;
          return {
            ...base,
            commissionPool: parseFloat(item.CommissionPool) || 0,
            commissionAmount: parseFloat(item.CommissionAmount) || 0,
            overflowAmount: parseFloat(item.CommissionAmount) || 0, // Same as commissionAmount
            ruleIds: Array.isArray(ruleIds) ? ruleIds : [],
            ruleId: item.RuleId || null, // Can have rule if from tiered commission
            ruleName: item.RuleName || (hasRules ? null : 'Overflow'), // Show rule name or "Overflow"
            commissionType: item.CommissionType || null,
            tierLevel: item.EntityTierLevel ?? null // Use agency's tier level, not rule's tier level
          };
        } else {
          // Agents can have rules
          return {
            ...base,
            commissionPool: parseFloat(item.CommissionPool) || 0,
            commissionAmount: parseFloat(item.CommissionAmount) || 0,
            ruleId: item.RuleId || null,
            ruleName: item.RuleName || null,
            commissionType: item.CommissionType || null,
            tierLevel: item.EntityTierLevel ?? null, // Use agent's tier level, not rule's tier level
            ruleIds: Array.isArray(ruleIds) ? ruleIds : (item.RuleId ? [item.RuleId] : [])
          };
        }
      } else if (entityType === 'Vendor') {
        // For vendors, calculate entity-specific vendor payout from ProductVendorAmounts
        // This is the NetRate for products belonging to THIS vendor, not the total NetRate
        let vendorPayout = 0;
        if (item.ProductVendorAmounts) {
          try {
            const productVendorAmounts = typeof item.ProductVendorAmounts === 'string'
              ? JSON.parse(item.ProductVendorAmounts)
              : item.ProductVendorAmounts;
            
            // Handle both object and array formats
            let vendorAmountsObj = {};
            if (Array.isArray(productVendorAmounts)) {
              for (const item of productVendorAmounts) {
                if (item && item.ProductId) {
                  vendorAmountsObj[item.ProductId.toString().toUpperCase()] = {
                    enrolledHouseholdsCount: item.EnrolledHouseholdsCount !== undefined ? item.EnrolledHouseholdsCount : 0,
                    vendorAmount: parseFloat(item.VendorAmount) || 0
                  };
                }
              }
            } else {
              vendorAmountsObj = productVendorAmounts;
            }
            
            // Get product IDs from ProductVendorAmounts
            const productIds = Object.keys(vendorAmountsObj).filter(pid => 
              vendorAmountsObj[pid] && vendorAmountsObj[pid].vendorAmount > 0
            );
            
            if (productIds.length > 0) {
              // Single query to check which products belong to this vendor
              const pool = await getPool();
              const productCheckRequest = pool.request();
              productCheckRequest.input('VendorId', sql.UniqueIdentifier, entityId);
              
              // Build query using OR conditions
              const productIdConditions = productIds.map((pid, idx) => {
                productCheckRequest.input(`ProductId${idx}`, sql.UniqueIdentifier, pid);
                return `ProductId = @ProductId${idx}`;
              }).join(' OR ');
              
              const productCheckQuery = `
                SELECT ProductId
                FROM oe.Products
                WHERE (${productIdConditions})
                  AND VendorId = @VendorId
              `;
              
              const productCheckResult = await productCheckRequest.query(productCheckQuery);
              
              // Build set of product IDs belonging to this vendor for fast lookup
              const vendorProductIds = new Set(
                productCheckResult.recordset.map(row => row.ProductId.toString().toUpperCase())
              );
              
              // Sum vendor amounts for products belonging to this vendor
              for (const [productIdStr, vendorData] of Object.entries(vendorAmountsObj)) {
                if (vendorData && vendorData.vendorAmount && vendorProductIds.has(productIdStr.toUpperCase())) {
                  vendorPayout += parseFloat(vendorData.vendorAmount) || 0;
                }
              }
            }
          } catch (error) {
            logger.warn('Error parsing ProductVendorAmounts for entity-specific vendor payout', {
              paymentId: item.PaymentId,
              error: error.message
            }, 'NACHA');
            // Fallback to total NetRate if parsing fails
            vendorPayout = parseFloat(item.VendorPayout) || 0;
          }
        } else {
          // No ProductVendorAmounts JSON - fallback to total NetRate
          vendorPayout = parseFloat(item.VendorPayout) || 0;
        }

        // Subtract amounts already paid for this vendor/payment via Sent Vendor NACHA generations
        const vendorPayoutGross = parseFloat(vendorPayout) || 0;
        const vendorAlreadyPaid = parseFloat(item.VendorAlreadyPaid) || 0;
        const vendorPayoutRemaining = Math.round(Math.max(0, vendorPayoutGross - vendorAlreadyPaid) * 100) / 100;

        // If fully paid, omit this payment from the "Payment Details" list
        if (vendorPayoutRemaining <= 0) {
          return null;
        }
        
        return {
          ...base,
          vendorPayout: vendorPayoutRemaining, // Remaining payable vendor payout amount (net of prior NACHA payments)
          vendorPayoutGross: vendorPayoutGross,
          vendorAlreadyPaid: vendorAlreadyPaid,
          commissionPool: parseFloat(item.CommissionPool) || 0,
          overrideRate: parseFloat(item.OverrideRate) || 0,
          tenantName: item.TenantName || null
        };
      } else if (entityType === 'Tenant') {
        // For product owners, calculate entity-specific override amount from ProductOwnerAmounts
        // This is the override amount for products owned by THIS tenant, not the total override rate
        let entityOverridePayout = 0;
        if (item.ProductOwnerAmounts) {
          try {
            const productOwnerAmounts = typeof item.ProductOwnerAmounts === 'string'
              ? JSON.parse(item.ProductOwnerAmounts)
              : item.ProductOwnerAmounts;
            
            // Handle both object and array formats
            let ownerAmountsObj = {};
            if (Array.isArray(productOwnerAmounts)) {
              for (const item of productOwnerAmounts) {
                if (item && item.ProductId) {
                  ownerAmountsObj[item.ProductId.toString().toUpperCase()] = {
                    enrolledHouseholdsCount: item.EnrolledHouseholdsCount !== undefined ? item.EnrolledHouseholdsCount : 0,
                    overrideAmount: parseFloat(item.OverrideAmount) || 0
                  };
                }
              }
            } else {
              ownerAmountsObj = productOwnerAmounts;
            }
            
            // Get product IDs from ProductOwnerAmounts
            const productIds = Object.keys(ownerAmountsObj).filter(pid => 
              ownerAmountsObj[pid] && ownerAmountsObj[pid].overrideAmount > 0
            );
            
            if (productIds.length > 0) {
              // Single query to check which products are owned by this tenant
              const pool = await getPool();
              const productCheckRequest = pool.request();
              productCheckRequest.input('TenantId', sql.UniqueIdentifier, entityId);
              
              // Build query using EXISTS or multiple OR conditions (SQL Server doesn't support IN with parameterized array easily)
              // Use a table-valued parameter or build OR conditions
              const productIdConditions = productIds.map((pid, idx) => {
                productCheckRequest.input(`ProductId${idx}`, sql.UniqueIdentifier, pid);
                return `ProductId = @ProductId${idx}`;
              }).join(' OR ');
              
              const productCheckQuery = `
                SELECT ProductId
                FROM oe.Products
                WHERE (${productIdConditions})
                  AND ProductOwnerId = @TenantId
              `;
              
              const productCheckResult = await productCheckRequest.query(productCheckQuery);
              
              // Build set of product IDs owned by this tenant for fast lookup
              const ownedProductIds = new Set(
                productCheckResult.recordset.map(row => row.ProductId.toString().toUpperCase())
              );
              
              // Sum override amounts for products owned by this tenant
              for (const [productIdStr, ownerData] of Object.entries(ownerAmountsObj)) {
                if (ownerData && ownerData.overrideAmount && ownedProductIds.has(productIdStr.toUpperCase())) {
                  entityOverridePayout += parseFloat(ownerData.overrideAmount) || 0;
                }
              }
            }
          } catch (error) {
            logger.warn('Error parsing ProductOwnerAmounts for entity-specific override', {
              paymentId: item.PaymentId,
              error: error.message
            }, 'NACHA');
            // Fallback to total override rate if parsing fails
            entityOverridePayout = parseFloat(item.OverridePayout) || 0;
          }
        } else {
          // No ProductOwnerAmounts JSON - fallback to total override rate
          entityOverridePayout = parseFloat(item.OverridePayout) || 0;
        }
        
        return {
          ...base,
          overridePayout: parseFloat(item.OverridePayout) || 0, // Total override rate
          entityOverridePayout: entityOverridePayout, // Entity-specific override amount
          commissionPool: parseFloat(item.CommissionPool) || 0,
          netRate: parseFloat(item.NetRate) || 0,
          overflowAmount: parseFloat(item.OverflowAmount) || 0
        };
      }
      
      return base;
    }))).filter(Boolean);

    // Diagnostic: surfaces credit-funded inclusion / vendor-share computations
    // when the modal total disagrees with the NACHA preview total. Logs the
    // count of rows that survived post-processing and the per-funding-source
    // breakdown. Remove (or downgrade to debug) once the prod modal totals
    // are stable.
    try {
      const bySource = paymentDetails.reduce((acc, p) => {
        const src = p.fundingSource || 'Payment';
        acc[src] = (acc[src] || 0) + 1;
        return acc;
      }, {});
      const totalReturned = paymentDetails.reduce((sum, p) => {
        if (entityType === 'Vendor') return sum + (p.vendorPayout || 0);
        if (entityType === 'Tenant') return sum + ((p.entityOverridePayout ?? p.overridePayout) || 0);
        if (entityType === 'Agent' || entityType === 'Agency') return sum + (p.commissionAmount || 0);
        return sum;
      }, 0);
      logger.info('Preview recipient payments response', {
        entityType,
        entityId,
        startDate: startDateUTC,
        endDate: endDateUTC,
        rowsReturned: paymentDetails.length,
        bySource,
        totalReturned: Math.round(totalReturned * 100) / 100,
        creditInvoiceIds: paymentDetails
          .filter(p => p.fundingSource === 'Credit')
          .map(p => p.invoiceId)
          .slice(0, 10)
      }, 'NACHA');
    } catch (logErr) {
      // Logging must never break the response
    }

    // Attach effective commission group name for agent/agency invoice rows.
    if (entityType === 'Agent' || entityType === 'Agency') {
      let tenantIdForGroup = previewTenantId;
      if (!tenantIdForGroup) {
        const tenantLookup = pool.request();
        tenantLookup.input('EntityId', sql.UniqueIdentifier, entityId);
        const tenantSql = entityType === 'Agency'
          ? 'SELECT TenantId FROM oe.Agencies WHERE AgencyId = @EntityId'
          : 'SELECT TenantId FROM oe.Agents WHERE AgentId = @EntityId';
        const tenantRes = await tenantLookup.query(tenantSql);
        tenantIdForGroup = tenantRes.recordset[0]?.TenantId
          ? tenantRes.recordset[0].TenantId.toString()
          : null;
      }

      if (tenantIdForGroup) {
        const CommissionCalculatorService = require('../../services/CommissionCalculatorService');
        const calc = new CommissionCalculatorService();
        const groupNameByAgentId = new Map();

        const resolveCommissionGroupName = async (agentIdForGroup) => {
          if (!agentIdForGroup) return null;
          const cacheKey = String(agentIdForGroup).toUpperCase();
          if (groupNameByAgentId.has(cacheKey)) {
            return groupNameByAgentId.get(cacheKey);
          }
          let name = null;
          try {
            const groupId = await calc.resolveCommissionGroupId(agentIdForGroup, tenantIdForGroup);
            const nameReq = pool.request();
            nameReq.input('GroupId', sql.UniqueIdentifier, groupId);
            const nameRes = await nameReq.query(`
              SELECT Name FROM oe.CommissionGroups WHERE CommissionGroupId = @GroupId
            `);
            name = nameRes.recordset[0]?.Name || null;
          } catch (groupErr) {
            logger.warn('Could not resolve commission group for preview payment row', {
              agentIdForGroup,
              tenantIdForGroup,
              error: groupErr.message
            }, 'NACHA');
          }
          groupNameByAgentId.set(cacheKey, name);
          return name;
        };

        for (const row of paymentDetails) {
          const agentIdForGroup = entityType === 'Agent'
            ? entityId
            : (row.sellingAgentId || null);
          row.commissionGroupName = await resolveCommissionGroupName(agentIdForGroup);
        }
      }
    }

    res.json({
      success: true,
      paymentDetails
    });
  } catch (error) {
    logger.error('Error getting preview payment details', {
      error: error.message,
      entityType: req.params.entityType,
      entityId: req.params.entityId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: 'Failed to get payment details'
    });
  }
});

/**
 * GET /api/accounting/nacha/export-all
 * Get detailed export data for ALL entities
 */
router.get('/export-all', async (req, res) => {
  try {
    console.log('🔍 /export-all route hit:', req.query);
    const { startDate, endDate, nachaId, entityTypes } = req.query;
    
    // Parse entityTypes if passed as string/array
    let types = [];
    if (entityTypes) {
      if (Array.isArray(entityTypes)) {
        types = entityTypes;
      } else if (typeof entityTypes === 'string') {
        // Try to parse as JSON first, otherwise treat as single value
        try {
          const parsed = JSON.parse(entityTypes);
          types = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          types = [entityTypes];
        }
      }
    }

    console.log('📊 Calling getAllExportDetails with:', { startDate, endDate, nachaId, types });
    const data = await nachaService.getAllExportDetails(
      startDate || null,
      endDate || null,
      nachaId || null,
      types
    );

    console.log('✅ getAllExportDetails returned:', { summaryCount: data.summary?.length, paymentsCount: data.payments?.length });
    res.json({
      success: true,
      ...data
    });
  } catch (error) {
    console.error('❌ Error in /export-all route:', error);
    logger.error('Error getting all export details', {
      error: error.message,
      stack: error.stack,
      nachaId: req.query.nachaId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: 'Failed to get all export details'
    });
  }
});

/**
 * GET /api/accounting/nacha/export-details/:entityType/:entityId
 * Get detailed export data for a specific entity (Agent/Agency)
 * Query params: startDate, endDate, nachaId
 */
router.get('/export-details/:entityType/:entityId', async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    const { startDate, endDate, nachaId } = req.query;

    const data = await nachaService.getExportDetails(
      entityType,
      entityId,
      startDate || null,
      endDate || null,
      nachaId || null
    );

    res.json({
      success: true,
      ...data
    });
  } catch (error) {
    logger.error('Error getting export details', {
      error: error.message,
      entityType: req.params.entityType,
      entityId: req.params.entityId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: 'Failed to get export details'
    });
  }
});

/**
 * GET /api/accounting/nacha/:nachaId/recipient/:entityType/:entityId/payments
 * Get individual payment details for a specific recipient
 */
router.get('/:nachaId/recipient/:entityType/:entityId/payments', async (req, res) => {
  try {
    const { nachaId, entityType, entityId } = req.params;

    const { getPool, sql } = require('../../config/database');
    const pool = await getPool();
    const request = pool.request();
    request.input('NACHAId', sql.UniqueIdentifier, nachaId);
    request.input('EntityType', sql.VarChar, entityType);
    request.input('EntityId', sql.UniqueIdentifier, entityId);

    // Reach the invoice via either the payment's InvoiceId or the NPD's
    // InvoiceId (credit-funded rows where npd.PaymentId IS NULL). Same
    // pattern used by getEligibleCommissions / NACHAService.getUnpaidPayments.
    // Pre-shift this only joined via p.InvoiceId so credit-funded NACHA
    // detail rows lost their invoice context entirely.
    const result = await request.query(`
      SELECT
        npd.NACHAPaymentDetailId,
        npd.PaymentId,
        COALESCE(p.InvoiceId, npd.InvoiceId) AS InvoiceId,
        inv.InvoiceNumber,
        inv.Status AS InvoiceStatus,
        inv.PaymentReceivedDate AS InvoicePaidDate,
        npd.Amount,
        npd.TierLevel,
        npd.CommissionRuleId,
        cr.RuleName,
        cr.CommissionType,
        cr.CommissionRate,
        cr.FlatAmount,
        COALESCE(p.PaymentDate, inv.BillingPeriodStart) as PaymentDate,
        COALESCE(p.Amount, inv.TotalAmount) as PaymentAmount,
        COALESCE(inv.Commission, p.Commission) as Commission,
        COALESCE(inv.NetRate, p.NetRate) as NetRate,
        COALESCE(inv.OverrideRate, p.OverrideRate) as OverrideRate,
        p.AgentId as SellingAgentId,
        CASE WHEN p.PaymentId IS NULL THEN 'Credit' ELSE 'Payment' END as FundingSource,
        u.FirstName + ' ' + u.LastName as MemberName,
        m.MemberId,
        sellingAgentUser.FirstName + ' ' + sellingAgentUser.LastName as SellingAgentName,
        pr.ProductOwnerId,
        t.Name as TenantName,
        COALESCE(p.GroupId, inv.GroupId) as GroupId,
        g.Name as GroupName
      FROM oe.NACHAPaymentDetails npd
      LEFT JOIN oe.CommissionRules cr ON npd.CommissionRuleId = cr.RuleId
      LEFT JOIN oe.Payments p ON npd.PaymentId = p.PaymentId
      LEFT JOIN oe.Invoices inv ON inv.InvoiceId = COALESCE(p.InvoiceId, npd.InvoiceId)
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON COALESCE(e.MemberId,
                                         (SELECT TOP 1 MemberId FROM oe.Members
                                          WHERE HouseholdId = inv.HouseholdId AND RelationshipType = 'P')) = m.MemberId
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Agents sellingAgent ON p.AgentId = sellingAgent.AgentId
      LEFT JOIN oe.Users sellingAgentUser ON sellingAgent.UserId = sellingAgentUser.UserId
      LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
      LEFT JOIN oe.Tenants t ON pr.ProductOwnerId = t.TenantId
      LEFT JOIN oe.Groups g ON COALESCE(p.GroupId, inv.GroupId) = g.GroupId
      WHERE npd.NACHAId = @NACHAId
        AND npd.RecipientEntityType = @EntityType
        AND npd.RecipientEntityId = @EntityId
      ORDER BY COALESCE(p.PaymentDate, inv.BillingPeriodStart) DESC, npd.Amount DESC
    `);

    const rawDetails = result.recordset.map(item => ({
      nachaPaymentDetailId: item.NACHAPaymentDetailId,
      paymentId: item.PaymentId ? item.PaymentId.toString() : null,
      invoiceId: item.InvoiceId ? item.InvoiceId.toString() : null,
      invoiceNumber: item.InvoiceNumber || null,
      invoiceStatus: item.InvoiceStatus || null,
      invoicePaidDate: item.InvoicePaidDate || null,
      fundingSource: item.FundingSource || 'Payment',
      amount: parseFloat(item.Amount) || 0,
      tierLevel: item.TierLevel,
      ruleId: item.CommissionRuleId || null,
      ruleName: item.RuleName || null,
      commissionType: item.CommissionType || null,
      commissionRate: item.CommissionRate !== null && item.CommissionRate !== undefined ? parseFloat(item.CommissionRate) : null,
      flatAmount: item.FlatAmount !== null && item.FlatAmount !== undefined ? parseFloat(item.FlatAmount) : null,
      paymentDate: item.PaymentDate,
      paymentAmount: parseFloat(item.PaymentAmount) || 0,
      commissionAmount: parseFloat(item.Commission) || 0,
      netRate: item.NetRate !== null && item.NetRate !== undefined ? parseFloat(item.NetRate) : 0,
      overrideRate: item.OverrideRate !== null && item.OverrideRate !== undefined ? parseFloat(item.OverrideRate) : 0,
      memberName: item.MemberName || 'Unknown',
      memberId: item.MemberId ? item.MemberId.toString() : null,
      sellingAgentId: item.SellingAgentId ? item.SellingAgentId.toString() : null,
      sellingAgentName: item.SellingAgentName || null,
      productOwnerId: item.ProductOwnerId ? item.ProductOwnerId.toString() : null,
      tenantName: item.TenantName || 'Product Owner',
      groupId: item.GroupId ? item.GroupId.toString() : null,
      groupName: item.GroupName || null
    }));

    const byInvoice = new Map();
    for (const row of rawDetails) {
      const key = row.invoiceId || row.paymentId || row.nachaPaymentDetailId;
      if (!byInvoice.has(key)) {
        byInvoice.set(key, {
          ...row,
          amount: 0,
          commissionAmount: 0,
          lineCount: 0,
          nachaPaymentDetailIds: [],
          tierLevels: new Set()
        });
      }
      const agg = byInvoice.get(key);
      agg.amount = Math.round((agg.amount + row.amount) * 100) / 100;
      agg.commissionAmount = Math.round((agg.commissionAmount + (row.commissionAmount || row.amount)) * 100) / 100;
      agg.lineCount += 1;
      agg.nachaPaymentDetailIds.push(row.nachaPaymentDetailId);
      if (row.tierLevel !== null && row.tierLevel !== undefined) {
        agg.tierLevels.add(row.tierLevel);
      }
      if (!agg.invoiceNumber && row.invoiceNumber) agg.invoiceNumber = row.invoiceNumber;
      if (!agg.invoiceStatus && row.invoiceStatus) agg.invoiceStatus = row.invoiceStatus;
      if (!agg.invoicePaidDate && row.invoicePaidDate) agg.invoicePaidDate = row.invoicePaidDate;
      if (!agg.paymentDate && row.paymentDate) agg.paymentDate = row.paymentDate;
      if (!agg.paymentAmount && row.paymentAmount) agg.paymentAmount = row.paymentAmount;
      if (!agg.memberName && row.memberName) agg.memberName = row.memberName;
      if (!agg.groupName && row.groupName) agg.groupName = row.groupName;
      if (!agg.groupId && row.groupId) agg.groupId = row.groupId;
      if (!agg.sellingAgentName && row.sellingAgentName) agg.sellingAgentName = row.sellingAgentName;
      if (!agg.paymentId && row.paymentId) agg.paymentId = row.paymentId;
    }

    const paymentDetails = Array.from(byInvoice.values())
      .map((row) => {
        const tiers = [...(row.tierLevels || [])].sort((a, b) => a - b);
        let tierLevel = row.tierLevel;
        if (tiers.length === 1) tierLevel = tiers[0];
        else if (tiers.length > 1) tierLevel = tiers.includes(0) ? 0 : tiers[0];
        const { tierLevels, ...rest } = row;
        return { ...rest, tierLevel };
      })
      .sort(
        (a, b) => new Date(b.paymentDate || 0).getTime() - new Date(a.paymentDate || 0).getTime()
      );

    res.json({
      success: true,
      paymentDetails,
      groupedBy: 'invoice'
    });
  } catch (error) {
    logger.error('Error getting recipient payment details', {
      error: error.message,
      nachaId: req.params.nachaId,
      entityType: req.params.entityType,
      entityId: req.params.entityId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: 'Failed to get payment details'
    });
  }
});

/**
 * GET /api/accounting/nacha/payment/:paymentId/enrollments
 * Get enrollments that make up a payment
 */
router.get('/payment/:paymentId/enrollments', async (req, res) => {
  try {
    const { paymentId } = req.params;

    const { getPool, sql } = require('../../config/database');
    const pool = await getPool();
    const request = pool.request();
    request.input('PaymentId', sql.UniqueIdentifier, paymentId);

    const result = await request.query(`
      SELECT 
        e.EnrollmentId,
        p.Name as ProductName,
        u.FirstName + ' ' + u.LastName as MemberName,
        e.NetRate,
        e.OverrideRate,
        e.Commission,
        e.SystemFees,
        e.EffectiveDate,
        e.TerminationDate,
        e.Status
      FROM oe.Payments pay
      INNER JOIN oe.Enrollments e ON pay.HouseholdId = e.HouseholdId
      INNER JOIN oe.Members m ON e.MemberId = m.MemberId
      INNER JOIN oe.Users u ON m.UserId = u.UserId
      INNER JOIN oe.Products p ON e.ProductId = p.ProductId
      WHERE pay.PaymentId = @PaymentId
        AND e.EffectiveDate <= pay.PaymentDate
        AND (e.TerminationDate IS NULL OR e.TerminationDate > pay.PaymentDate)
      ORDER BY e.EffectiveDate DESC
    `);

    const enrollments = result.recordset.map(item => ({
      enrollmentId: item.EnrollmentId,
      productName: item.ProductName,
      memberName: item.MemberName,
      netRate: parseFloat(item.NetRate) || 0,
      overrideRate: parseFloat(item.OverrideRate) || 0,
      commission: parseFloat(item.Commission) || 0,
      systemFees: parseFloat(item.SystemFees) || 0,
      effectiveDate: item.EffectiveDate,
      terminationDate: item.TerminationDate,
      status: item.Status
    }));

    res.json({
      success: true,
      enrollments
    });
  } catch (error) {
    logger.error('Error getting payment enrollments', {
      error: error.message,
      paymentId: req.params.paymentId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: 'Failed to get payment enrollments'
    });
  }
});

/**
 * GET /api/accounting/nacha/payment/:paymentId/vendor/:vendorId/product-breakdown
 * For a single payment + vendor, return per-product household counts and vendor payout totals.
 *
 * - vendorPayoutAmount: sourced from oe.Payments.ProductVendorAmounts snapshot (source of truth)
 * - householdsCount: computed as COUNT(DISTINCT primary HouseholdId) active at PaymentDate
 */
router.get('/payment/:paymentId/vendor/:vendorId/product-breakdown', authenticate, async (req, res) => {
  try {
    const { paymentId, vendorId } = req.params;

    const { getPool, sql } = require('../../config/database');
    const pool = await getPool();

    const paymentResult = await pool
      .request()
      .input('PaymentId', sql.UniqueIdentifier, paymentId)
      .query(`
        SELECT PaymentId, PaymentDate, HouseholdId, GroupId, InvoiceId, ProductVendorAmounts
        FROM oe.Payments
        WHERE PaymentId = @PaymentId
      `);

    if (!paymentResult.recordset || paymentResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    const payment = paymentResult.recordset[0];
    const paymentDate = payment.PaymentDate;
    const groupId = payment.GroupId || null;
    const householdId = payment.HouseholdId || null;
    const invoiceId = payment.InvoiceId || null;

    // For group payments, household/product counts should align to the invoice billing period (matches group billing + payment audit).
    let periodStart = null;
    let periodEnd = null;
    if (groupId && invoiceId) {
      try {
        const invRes = await pool.request()
          .input('InvoiceId', sql.UniqueIdentifier, invoiceId)
          .query(`
            SELECT TOP 1 BillingPeriodStart, BillingPeriodEnd
            FROM oe.Invoices
            WHERE InvoiceId = @InvoiceId
          `);
        const inv = invRes.recordset?.[0] || null;
        if (inv?.BillingPeriodStart && inv?.BillingPeriodEnd) {
          periodStart = inv.BillingPeriodStart;
          periodEnd = inv.BillingPeriodEnd;
        }
      } catch (e) {
        // fall through to paymentDate
      }
    }

    const normalizeProductVendorAmounts = (raw) => {
      if (!raw) return {};
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) {
          const obj = {};
          for (const item of parsed) {
            if (!item || !item.ProductId) continue;
            const key = String(item.ProductId).toUpperCase();
            obj[key] = {
              vendorAmount: Number(item.VendorAmount ?? item.vendorAmount ?? 0),
              enrolledHouseholdsCount: Number(
                item.EnrolledHouseholdsCount ?? item.enrolledHouseholdsCount ?? item.enrollmentCount ?? item.EnrollmentCount ?? 0
              )
            };
          }
          return obj;
        }
        if (parsed && typeof parsed === 'object') {
          const obj = {};
          for (const [k, v] of Object.entries(parsed)) {
            obj[String(k).toUpperCase()] = v;
          }
          return obj;
        }
      } catch (e) {
        // fall through
      }
      return {};
    };

    const vendorAmountsObj = normalizeProductVendorAmounts(payment.ProductVendorAmounts);
    const productIdsFromSnapshot = Object.keys(vendorAmountsObj).filter(
      (pid) => pid && pid !== '00000000-0000-0000-0000-000000000000'
    );

    if (productIdsFromSnapshot.length === 0) {
      return res.json({ success: true, products: [] });
    }

    // Filter to only products that belong to this vendor
    const productsReq = pool.request();
    productsReq.input('VendorId', sql.UniqueIdentifier, vendorId);
    productIdsFromSnapshot.forEach((pid, idx) => {
      productsReq.input(`ProductId${idx}`, sql.UniqueIdentifier, pid);
    });
    const productIdConditions = productIdsFromSnapshot
      .map((_, idx) => `p.ProductId = @ProductId${idx}`)
      .join(' OR ');

    const productsResult = await productsReq.query(`
      SELECT p.ProductId, p.Name
      FROM oe.Products p
      WHERE p.VendorId = @VendorId
        AND (${productIdConditions})
    `);

    const vendorProductRows = productsResult.recordset || [];
    if (vendorProductRows.length === 0) {
      return res.json({ success: true, products: [] });
    }

    const vendorProductIds = vendorProductRows.map((r) => r.ProductId.toString().toUpperCase());

    // Compute distinct primary household counts per product.
    // For group payments: use invoice billing period overlap to match stored snapshot/audit.
    // For household payments: use PaymentDate (as-of).
    const householdCounts = new Map(); // productId -> householdsCount
    if (paymentDate && (groupId || householdId)) {
      const countsReq = pool.request();
      if (groupId) {
        countsReq.input('GroupId', sql.UniqueIdentifier, groupId);
        countsReq.input('PeriodStart', sql.DateTime2, periodStart || paymentDate);
        countsReq.input('PeriodEnd', sql.DateTime2, periodEnd || paymentDate);
      }
      if (householdId) countsReq.input('HouseholdId', sql.UniqueIdentifier, householdId);
      if (!groupId) countsReq.input('PaymentDate', sql.DateTime2, paymentDate);

      vendorProductIds.forEach((pid, idx) => {
        countsReq.input(`CProductId${idx}`, sql.UniqueIdentifier, pid);
      });
      const inConditions = vendorProductIds.map((_, idx) => `@CProductId${idx}`).join(', ');

      const scopeWhere = groupId
        ? 'm.GroupId = @GroupId'
        : 'm.HouseholdId = @HouseholdId';

      const dateWhere = groupId
        ? 'e.EffectiveDate <= @PeriodEnd AND (e.TerminationDate IS NULL OR e.TerminationDate > @PeriodStart)'
        : 'e.EffectiveDate <= @PaymentDate AND (e.TerminationDate IS NULL OR e.TerminationDate > @PaymentDate)';

      const countsResult = await countsReq.query(`
        SELECT
          e.ProductId,
          COUNT(DISTINCT m.HouseholdId) as HouseholdsCount
        FROM oe.Members m
        INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
        WHERE ${scopeWhere}
          AND m.RelationshipType = 'P'
          AND e.EnrollmentType = 'Product'
          AND e.ProductId IN (${inConditions})
          AND ${dateWhere}
        GROUP BY e.ProductId
      `);

      (countsResult.recordset || []).forEach((row) => {
        const pid = row.ProductId ? row.ProductId.toString().toUpperCase() : null;
        if (!pid) return;
        householdCounts.set(pid, Number(row.HouseholdsCount || 0));
      });
    }

    const products = vendorProductRows
      .map((row) => {
        const pid = row.ProductId.toString().toUpperCase();
        const snapshot = vendorAmountsObj[pid] || vendorAmountsObj[pid.toLowerCase()] || null;
        const vendorPayoutAmount = Number(snapshot?.vendorAmount ?? snapshot?.VendorAmount ?? 0);
        return {
          productId: pid,
          productName: row.Name || `Product ${pid.substring(0, 8)}...`,
          householdsCount: householdCounts.get(pid) ?? 0,
          vendorPayoutAmount
        };
      })
      .filter((p) => p.vendorPayoutAmount > 0 || p.householdsCount > 0)
      .sort((a, b) => a.productName.localeCompare(b.productName));

    res.json({ success: true, products });
  } catch (error) {
    logger.error('Error getting vendor product breakdown', {
      error: error.message,
      paymentId: req.params.paymentId,
      vendorId: req.params.vendorId
    }, 'NACHA');
    res.status(500).json({ success: false, message: 'Failed to get vendor product breakdown' });
  }
});

/**
 * GET /api/accounting/nacha/payment/:paymentId/product/:productId/households
 * Get household-level details for a specific payment and product
 * Query params: entityType, entityId, page, limit
 */
router.get('/payment/:paymentId/product/:productId/households', authenticate, async (req, res) => {
  try {
    const { paymentId, productId } = req.params;
    const { entityType, entityId, page = 1, limit = 50 } = req.query;
    
    if (!entityType || !entityId) {
      return res.status(400).json({
        success: false,
        message: 'entityType and entityId are required'
      });
    }

    const { getPool, sql } = require('../../config/database');
    const pool = await getPool();
    const request = pool.request();
    request.input('PaymentId', sql.UniqueIdentifier, paymentId);
    request.input('ProductId', sql.UniqueIdentifier, productId);
    request.input('EntityType', sql.VarChar(50), entityType);
    request.input('EntityId', sql.UniqueIdentifier, entityId);
    request.input('Page', sql.Int, parseInt(page));
    request.input('Limit', sql.Int, parseInt(limit));
    request.input('Offset', sql.Int, (parseInt(page) - 1) * parseInt(limit));

    // Get payment details first
    const paymentResult = await pool.request()
      .input('PaymentId', sql.UniqueIdentifier, paymentId)
      .query(`
        SELECT 
          PaymentId,
          PaymentDate,
          InvoiceId,
          HouseholdId,
          GroupId,
          ProductCommissions,
          ProductVendorAmounts,
          ProductOwnerAmounts
        FROM oe.Payments
        WHERE PaymentId = @PaymentId
      `);

    if (paymentResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    const payment = paymentResult.recordset[0];
    const isGroupPayment = payment.GroupId !== null;

    // For group payments, align household/product breakdown to the invoice billing period
    // (this matches how group payment snapshots + payment audit are computed).
    let periodStart = null;
    let periodEnd = null;
    if (isGroupPayment && payment.InvoiceId) {
      try {
        const invRes = await pool.request()
          .input('InvoiceId', sql.UniqueIdentifier, payment.InvoiceId)
          .query(`
            SELECT TOP 1 BillingPeriodStart, BillingPeriodEnd
            FROM oe.Invoices
            WHERE InvoiceId = @InvoiceId
          `);
        const inv = invRes.recordset?.[0] || null;
        if (inv?.BillingPeriodStart && inv?.BillingPeriodEnd) {
          periodStart = inv.BillingPeriodStart;
          periodEnd = inv.BillingPeriodEnd;
        }
      } catch (e) {
        // fall through to PaymentDate
      }
    }

    // Get household-level data with age band info
    // If ProductId is "All Products" (00000000-0000-0000-0000-000000000000), calculate total across all products
    // Otherwise, calculate only for the specific product
    const isAllProducts = productId.toUpperCase() === '00000000-0000-0000-0000-000000000000';
    let query;
    if (isGroupPayment) {
      // Group payment - get all households in the group with this product
      if (isAllProducts) {
        // For "All Products", show total household payment across all products
        query = `
          WITH HouseholdsWithProduct AS (
            SELECT DISTINCT m.HouseholdId
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE m.GroupId = @GroupId
              AND e.EffectiveDate <= @PeriodEnd
              AND (e.TerminationDate IS NULL OR e.TerminationDate > @PeriodStart)
              AND m.RelationshipType = 'P'
          ),
          TotalHouseholdPayment AS (
            SELECT 
              m.HouseholdId,
              COUNT(DISTINCT CASE WHEN e.EnrollmentType = 'Product' THEN e.EnrollmentId END) as EnrollmentCount,
              SUM(CASE WHEN e.EnrollmentType = 'Product' THEN COALESCE(e.Commission, 0) ELSE 0 END) as TotalCommission,
              SUM(CASE WHEN e.EnrollmentType = 'Product' THEN COALESCE(e.NetRate, 0) ELSE 0 END) as TotalNetRate,
              SUM(CASE WHEN e.EnrollmentType = 'Product' THEN COALESCE(e.OverrideRate, 0) ELSE 0 END) as TotalOverrideRate,
              SUM(CASE WHEN e.EnrollmentType = 'SystemFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) as TotalSystemFees,
              SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) as TotalProcessingFees,
              MIN(pp.MinAge) as MinAge,
              MAX(pp.MaxAge) as MaxAge,
              -- Get configuration value from first enrollment (primary member's enrollment) for the specific product
              -- Note: For "All Products", we can't show a single config value, so this will be NULL
              NULL as ConfigValue
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
            INNER JOIN HouseholdsWithProduct hwp ON m.HouseholdId = hwp.HouseholdId
            WHERE e.EffectiveDate <= @PeriodEnd
              AND (e.TerminationDate IS NULL OR e.TerminationDate > @PeriodStart)
              AND m.RelationshipType = 'P'
            GROUP BY m.HouseholdId
          )
          SELECT 
            hwp.HouseholdId,
            MIN(CONVERT(varchar(36), m.MemberId)) as PrimaryMemberId,
            COALESCE(u.FirstName + ' ' + u.LastName, 'Household ' + CAST(hwp.HouseholdId AS VARCHAR(36))) as HouseholdName,
            m.Tier as HouseholdTier,
            COALESCE(thp.EnrollmentCount, 0) as EnrollmentCount,
            COALESCE(thp.TotalCommission, 0) as TotalCommission,
            COALESCE(thp.TotalNetRate, 0) as TotalNetRate,
            COALESCE(thp.TotalOverrideRate, 0) as TotalOverrideRate,
            COALESCE(thp.TotalSystemFees, 0) as TotalSystemFees,
            COALESCE(thp.TotalProcessingFees, 0) as TotalProcessingFees,
            thp.MinAge,
            thp.MaxAge,
            thp.ConfigValue
          FROM HouseholdsWithProduct hwp
          INNER JOIN oe.Members m ON hwp.HouseholdId = m.HouseholdId AND m.RelationshipType = 'P'
          LEFT JOIN oe.Users u ON m.UserId = u.UserId
          LEFT JOIN TotalHouseholdPayment thp ON hwp.HouseholdId = thp.HouseholdId
          GROUP BY hwp.HouseholdId, u.FirstName, u.LastName, m.Tier, thp.EnrollmentCount, thp.TotalCommission, thp.TotalNetRate, thp.TotalOverrideRate, thp.TotalSystemFees, thp.TotalProcessingFees, thp.MinAge, thp.MaxAge, thp.ConfigValue
          ORDER BY HouseholdName
          OFFSET @Offset ROWS
          FETCH NEXT @Limit ROWS ONLY
        `;
      } else {
        // For specific product, show only that product's amounts
        // But include fees (which have ProductId = '00000000-0000-0000-0000-000000000000') for all households
        query = `
          WITH ProductEnrollments AS (
            SELECT 
              m.HouseholdId,
              COUNT(DISTINCT e.EnrollmentId) as EnrollmentCount,
              SUM(COALESCE(e.Commission, 0)) as TotalCommission,
              SUM(COALESCE(e.NetRate, 0)) as TotalNetRate,
              SUM(COALESCE(e.OverrideRate, 0)) as TotalOverrideRate,
              MIN(pp.MinAge) as MinAge,
              MAX(pp.MaxAge) as MaxAge,
              -- Get configuration value from first enrollment (primary member's enrollment)
              MAX(CASE WHEN m.RelationshipType = 'P' THEN 
                COALESCE(JSON_VALUE(e.EnrollmentDetails, '$.configuration'), pp.ConfigValue1, NULL)
              END) as ConfigValue
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
            WHERE m.GroupId = @GroupId
              AND e.ProductId = @ProductId
              AND e.EnrollmentType = 'Product'
              AND e.EffectiveDate <= @PeriodEnd
              AND (e.TerminationDate IS NULL OR e.TerminationDate > @PeriodStart)
            GROUP BY m.HouseholdId
          ),
          HouseholdFees AS (
            SELECT 
              m.HouseholdId,
              SUM(CASE WHEN e.EnrollmentType = 'SystemFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) as TotalSystemFees,
              SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) as TotalProcessingFees
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE m.GroupId = @GroupId
              AND e.EnrollmentType IN ('SystemFee', 'PaymentProcessingFee')
              AND e.EffectiveDate <= @PeriodEnd
              AND (e.TerminationDate IS NULL OR e.TerminationDate > @PeriodStart)
              AND m.RelationshipType = 'P'
            GROUP BY m.HouseholdId
          )
          SELECT 
            pe.HouseholdId,
            MIN(CONVERT(varchar(36), m.MemberId)) as PrimaryMemberId,
            COALESCE(u.FirstName + ' ' + u.LastName, 'Household ' + CAST(pe.HouseholdId AS VARCHAR(36))) as HouseholdName,
            m.Tier as HouseholdTier,
            COALESCE(pe.EnrollmentCount, 0) as EnrollmentCount,
            COALESCE(pe.TotalCommission, 0) as TotalCommission,
            COALESCE(pe.TotalNetRate, 0) as TotalNetRate,
            COALESCE(pe.TotalOverrideRate, 0) as TotalOverrideRate,
            COALESCE(hf.TotalSystemFees, 0) as TotalSystemFees,
            COALESCE(hf.TotalProcessingFees, 0) as TotalProcessingFees,
            pe.MinAge,
            pe.MaxAge,
            pe.ConfigValue
          FROM ProductEnrollments pe
          INNER JOIN oe.Members m ON pe.HouseholdId = m.HouseholdId AND m.RelationshipType = 'P'
          LEFT JOIN oe.Users u ON m.UserId = u.UserId
          LEFT JOIN HouseholdFees hf ON pe.HouseholdId = hf.HouseholdId
          GROUP BY pe.HouseholdId, u.FirstName, u.LastName, m.Tier, pe.EnrollmentCount, pe.TotalCommission, pe.TotalNetRate, pe.TotalOverrideRate, hf.TotalSystemFees, hf.TotalProcessingFees, pe.MinAge, pe.MaxAge, pe.ConfigValue
          ORDER BY HouseholdName
          OFFSET @Offset ROWS
          FETCH NEXT @Limit ROWS ONLY
        `;
      }
      request.input('GroupId', sql.UniqueIdentifier, payment.GroupId);
      request.input('PeriodStart', sql.DateTime2, periodStart || payment.PaymentDate);
      request.input('PeriodEnd', sql.DateTime2, periodEnd || payment.PaymentDate);
    } else {
      // Individual/household payment
      if (isAllProducts) {
        // For "All Products", show total household payment across all products
        query = `
          SELECT 
            m.HouseholdId,
            MIN(CONVERT(varchar(36), m.MemberId)) as PrimaryMemberId,
            COALESCE(u.FirstName + ' ' + u.LastName, 'Household ' + CAST(m.HouseholdId AS VARCHAR(36))) as HouseholdName,
            m.Tier as HouseholdTier,
            COUNT(DISTINCT CASE WHEN e.EnrollmentType = 'Product' THEN e.EnrollmentId END) as EnrollmentCount,
            SUM(CASE WHEN e.EnrollmentType = 'Product' THEN COALESCE(e.Commission, 0) ELSE 0 END) as TotalCommission,
            SUM(CASE WHEN e.EnrollmentType = 'Product' THEN COALESCE(e.NetRate, 0) ELSE 0 END) as TotalNetRate,
            SUM(CASE WHEN e.EnrollmentType = 'Product' THEN COALESCE(e.OverrideRate, 0) ELSE 0 END) as TotalOverrideRate,
            SUM(CASE WHEN e.EnrollmentType = 'SystemFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) as TotalSystemFees,
            SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) as TotalProcessingFees,
            MIN(pp.MinAge) as MinAge,
            MAX(pp.MaxAge) as MaxAge
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          LEFT JOIN oe.Users u ON m.UserId = u.UserId
          LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
          WHERE m.HouseholdId = @HouseholdId
            AND e.EffectiveDate <= @PaymentDate
            AND (e.TerminationDate IS NULL OR e.TerminationDate > @PaymentDate)
            AND m.RelationshipType = 'P'
          GROUP BY m.HouseholdId, u.FirstName, u.LastName, m.Tier
          ORDER BY HouseholdName
          OFFSET @Offset ROWS
          FETCH NEXT @Limit ROWS ONLY
        `;
      } else {
        // For specific product, show only that product's amounts
        // But include fees (which have ProductId = '00000000-0000-0000-0000-000000000000') for the household
        query = `
          WITH ProductEnrollments AS (
            SELECT 
              m.HouseholdId,
              COUNT(DISTINCT e.EnrollmentId) as EnrollmentCount,
              SUM(COALESCE(e.Commission, 0)) as TotalCommission,
              SUM(COALESCE(e.NetRate, 0)) as TotalNetRate,
              SUM(COALESCE(e.OverrideRate, 0)) as TotalOverrideRate,
              MIN(pp.MinAge) as MinAge,
              MAX(pp.MaxAge) as MaxAge,
              -- Get configuration value from first enrollment (primary member's enrollment)
              MAX(CASE WHEN m.RelationshipType = 'P' THEN 
                COALESCE(JSON_VALUE(e.EnrollmentDetails, '$.configuration'), pp.ConfigValue1, NULL)
              END) as ConfigValue
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
            WHERE m.HouseholdId = @HouseholdId
              AND e.ProductId = @ProductId
              AND e.EnrollmentType = 'Product'
              AND e.EffectiveDate <= @PaymentDate
              AND (e.TerminationDate IS NULL OR e.TerminationDate > @PaymentDate)
              AND m.RelationshipType = 'P'
            GROUP BY m.HouseholdId
          ),
          HouseholdFees AS (
            SELECT 
              m.HouseholdId,
              SUM(CASE WHEN e.EnrollmentType = 'SystemFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) as TotalSystemFees,
              SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) as TotalProcessingFees
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE m.HouseholdId = @HouseholdId
              AND e.EnrollmentType IN ('SystemFee', 'PaymentProcessingFee')
              AND e.EffectiveDate <= @PaymentDate
              AND (e.TerminationDate IS NULL OR e.TerminationDate > @PaymentDate)
              AND m.RelationshipType = 'P'
            GROUP BY m.HouseholdId
          )
          SELECT 
            pe.HouseholdId,
            MIN(CONVERT(varchar(36), m.MemberId)) as PrimaryMemberId,
            COALESCE(u.FirstName + ' ' + u.LastName, 'Household ' + CAST(pe.HouseholdId AS VARCHAR(36))) as HouseholdName,
            m.Tier as HouseholdTier,
            COALESCE(pe.EnrollmentCount, 0) as EnrollmentCount,
            COALESCE(pe.TotalCommission, 0) as TotalCommission,
            COALESCE(pe.TotalNetRate, 0) as TotalNetRate,
            COALESCE(pe.TotalOverrideRate, 0) as TotalOverrideRate,
            COALESCE(hf.TotalSystemFees, 0) as TotalSystemFees,
            COALESCE(hf.TotalProcessingFees, 0) as TotalProcessingFees,
            pe.MinAge,
            pe.MaxAge,
            pe.ConfigValue
          FROM ProductEnrollments pe
          INNER JOIN oe.Members m ON pe.HouseholdId = m.HouseholdId AND m.RelationshipType = 'P'
          LEFT JOIN oe.Users u ON m.UserId = u.UserId
          LEFT JOIN HouseholdFees hf ON pe.HouseholdId = hf.HouseholdId
          GROUP BY pe.HouseholdId, u.FirstName, u.LastName, m.Tier, pe.EnrollmentCount, pe.TotalCommission, pe.TotalNetRate, pe.TotalOverrideRate, hf.TotalSystemFees, hf.TotalProcessingFees, pe.MinAge, pe.MaxAge, pe.ConfigValue
          ORDER BY HouseholdName
          OFFSET @Offset ROWS
          FETCH NEXT @Limit ROWS ONLY
        `;
      }
      request.input('HouseholdId', sql.UniqueIdentifier, payment.HouseholdId);
      request.input('PaymentDate', sql.DateTime2, payment.PaymentDate);
    }

    const result = await request.query(query);

    // Get total count for pagination
    let countQuery;
    if (isGroupPayment) {
      countQuery = `
        SELECT COUNT(DISTINCT m.HouseholdId) as TotalCount
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @GroupId
          AND e.ProductId = @ProductId
          AND e.EffectiveDate <= @PeriodEnd
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @PeriodStart)
          AND m.RelationshipType = 'P'
      `;
    } else {
      countQuery = `
        SELECT COUNT(DISTINCT m.HouseholdId) as TotalCount
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.HouseholdId = @HouseholdId
          AND e.ProductId = @ProductId
          AND e.EffectiveDate <= @PaymentDate
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @PaymentDate)
          AND m.RelationshipType = 'P'
      `;
    }
    const countResult = await request.query(countQuery);
    const totalCount = countResult.recordset[0]?.TotalCount || 0;

    // Parse JSON columns to get per-product amounts
    let productCommissions = null;
    let productVendorAmounts = null;
    let productOwnerAmounts = null;
    
    if (payment.ProductCommissions) {
      try {
        productCommissions = typeof payment.ProductCommissions === 'string' 
          ? JSON.parse(payment.ProductCommissions) 
          : payment.ProductCommissions;
      } catch (e) {
        logger.warn('Could not parse ProductCommissions JSON', { paymentId, error: e.message }, 'NACHA');
      }
    }
    
    if (payment.ProductVendorAmounts) {
      try {
        productVendorAmounts = typeof payment.ProductVendorAmounts === 'string' 
          ? JSON.parse(payment.ProductVendorAmounts) 
          : payment.ProductVendorAmounts;
      } catch (e) {
        logger.warn('Could not parse ProductVendorAmounts JSON', { paymentId, error: e.message }, 'NACHA');
      }
    }
    
    if (payment.ProductOwnerAmounts) {
      try {
        productOwnerAmounts = typeof payment.ProductOwnerAmounts === 'string' 
          ? JSON.parse(payment.ProductOwnerAmounts) 
          : payment.ProductOwnerAmounts;
      } catch (e) {
        logger.warn('Could not parse ProductOwnerAmounts JSON', { paymentId, error: e.message }, 'NACHA');
      }
    }

    // Get total amounts for this product from JSON
    const productIdUpper = productId.toUpperCase();
    const productCommissionData = productCommissions?.[productIdUpper] || {};
    const productVendorData = productVendorAmounts?.[productIdUpper] || {};
    const productOwnerData = productOwnerAmounts?.[productIdUpper] || {};
    
    const totalProductCommission = parseFloat(productCommissionData.commissionAmount) || 0;
    const totalProductVendorAmount = parseFloat(productVendorData.vendorAmount) || 0;
    const totalProductOverrideAmount = parseFloat(productOwnerData.overrideAmount) || 0;
    const totalHouseholdsForProduct = productCommissionData.enrolledHouseholdsCount || 0;

    // Get the total entity payout for this product from the commission breakdown
    // We need to query the commission rows to get the actual payout amount for this entity
    let totalEntityPayoutForProduct = 0;
    try {
      const commissionRequest = pool.request();
      commissionRequest.input('PaymentId', sql.UniqueIdentifier, paymentId);
      commissionRequest.input('ProductId', sql.UniqueIdentifier, productId);
      commissionRequest.input('EntityType', sql.VarChar(50), entityType);
      commissionRequest.input('EntityId', sql.UniqueIdentifier, entityId);
      
      // For agents/agencies, get commission amount from oe.Commissions
      // For vendors/tenants, we'll use the product amounts from JSON
      if (entityType === 'Agent') {
        const commissionQuery = `
          SELECT SUM(c.Amount) as TotalPayout
          FROM oe.Commissions c
          INNER JOIN oe.Payments p ON c.PaymentId = p.PaymentId
          WHERE c.PaymentId = @PaymentId
            AND c.AgentId = @EntityId
            AND EXISTS (
              SELECT 1
              FROM oe.Enrollments e
              INNER JOIN oe.Members m ON e.MemberId = m.MemberId
              WHERE (e.EnrollmentId = p.EnrollmentId 
                     OR (p.HouseholdId IS NOT NULL AND e.HouseholdId = p.HouseholdId)
                     OR (p.GroupId IS NOT NULL AND m.GroupId = p.GroupId))
                AND e.ProductId = @ProductId
                AND e.EffectiveDate <= p.PaymentDate
                AND (e.TerminationDate IS NULL OR e.TerminationDate > p.PaymentDate)
            )
        `;
        const commissionResult = await commissionRequest.query(commissionQuery);
        totalEntityPayoutForProduct = parseFloat(commissionResult.recordset[0]?.TotalPayout) || 0;
      } else if (entityType === 'Agency') {
        const commissionQuery = `
          SELECT SUM(c.Amount) as TotalPayout
          FROM oe.Commissions c
          INNER JOIN oe.Payments p ON c.PaymentId = p.PaymentId
          WHERE c.PaymentId = @PaymentId
            AND c.AgencyId = @EntityId
            AND EXISTS (
              SELECT 1
              FROM oe.Enrollments e
              INNER JOIN oe.Members m ON e.MemberId = m.MemberId
              WHERE (e.EnrollmentId = p.EnrollmentId 
                     OR (p.HouseholdId IS NOT NULL AND e.HouseholdId = p.HouseholdId)
                     OR (p.GroupId IS NOT NULL AND m.GroupId = p.GroupId))
                AND e.ProductId = @ProductId
                AND e.EffectiveDate <= p.PaymentDate
                AND (e.TerminationDate IS NULL OR e.TerminationDate > p.PaymentDate)
            )
        `;
        const commissionResult = await commissionRequest.query(commissionQuery);
        totalEntityPayoutForProduct = parseFloat(commissionResult.recordset[0]?.TotalPayout) || 0;
      } else if (entityType === 'Vendor') {
        totalEntityPayoutForProduct = totalProductVendorAmount;
      } else if (entityType === 'Tenant') {
        totalEntityPayoutForProduct = totalProductOverrideAmount;
      }
    } catch (error) {
      logger.warn('Could not get total entity payout for product', {
        paymentId,
        productId,
        entityType,
        entityId,
        error: error.message
      }, 'NACHA');
    }
    
    // Calculate entity payout per household
    // For vendors: Use household's NetRate directly (no fees, no proportional calculation)
    // For agents/agencies: Use proportional share of commission
    // For tenants: Use proportional share of override
    const households = result.recordset.map(item => {
      const householdCommission = parseFloat(item.TotalCommission) || 0;
      const householdNetRate = parseFloat(item.TotalNetRate) || 0;
      const householdOverrideRate = parseFloat(item.TotalOverrideRate) || 0;
      const householdSystemFees = parseFloat(item.TotalSystemFees) || 0;
      const householdProcessingFees = parseFloat(item.TotalProcessingFees) || 0;
      
      // Calculate entity payout
      let entityPayout = 0;
      if (entityType === 'Vendor') {
        // For vendors: Use household's NetRate directly for this product (no fees, no proportional calculation)
        // This is the exact vendor payout for this household's enrollments in this product
        // householdNetRate is SUM(e.NetRate) for this household for this product from enrollments
        entityPayout = householdNetRate;
        
        // Log for debugging vendor payout calculation
        logger.info('Vendor payout calculation for household', {
          householdId: item.HouseholdId.toString(),
          householdName: item.HouseholdName,
          householdTier: item.HouseholdTier,
          productId: productId,
          enrollmentCount: item.EnrollmentCount,
          householdNetRate: householdNetRate,
          householdCommission: householdCommission,
          householdOverrideRate: householdOverrideRate,
          entityPayout: entityPayout,
          totalProductVendorAmount: totalProductVendorAmount,
          configValue: item.ConfigValue
        }, 'NACHA');
      } else if (entityType === 'Agent' || entityType === 'Agency') {
        // For agents/agencies, use commission share
        const householdShare = totalProductCommission > 0 ? householdCommission / totalProductCommission : 0;
        entityPayout = totalEntityPayoutForProduct * householdShare;
      } else if (entityType === 'Tenant') {
        // For tenants, use override amount share
        const householdShare = totalProductOverrideAmount > 0 ? householdOverrideRate / totalProductOverrideAmount : 0;
        entityPayout = totalEntityPayoutForProduct * householdShare;
      }
      
      // Calculate what household pays (total cost for this product)
      // Ensure all values are numbers (not null/undefined) before adding
      const householdPayment = (householdCommission || 0) + (householdNetRate || 0) + (householdOverrideRate || 0);
      
      // Build age band string (e.g., "Age 60-80" or "Age 60+")
      let ageBand = null;
      if (item.MinAge !== null && item.MinAge !== undefined) {
        const minAge = item.MinAge;
        const maxAge = item.MaxAge;
        if (maxAge !== null && maxAge !== undefined && maxAge < 999) {
          ageBand = `Age ${minAge}-${maxAge}`;
        } else {
          ageBand = `Age ${minAge}+`;
        }
      }
      
      return {
        householdId: item.HouseholdId.toString(),
        primaryMemberId: item.PrimaryMemberId ? item.PrimaryMemberId.toString() : null,
        householdName: item.HouseholdName || 'Unknown',
        householdTier: item.HouseholdTier || null,
        enrollmentCount: item.EnrollmentCount || 0,
        householdPayment: householdPayment,
        entityPayout: Math.round(entityPayout * 100) / 100, // Round to 2 decimal places for accuracy
        ageBand: ageBand,
        systemFees: householdSystemFees,
        processingFees: householdProcessingFees,
        totalFees: householdSystemFees + householdProcessingFees,
        configValue: item.ConfigValue || null
      };
    });

    // Get product's RequiredDataFields to determine configuration field name
    let configFieldName = null;
    if (!isAllProducts) {
      try {
        const productRequest = pool.request();
        productRequest.input('ProductId', sql.UniqueIdentifier, productId);
        const productResult = await productRequest.query(`
          SELECT RequiredDataFields
          FROM oe.Products
          WHERE ProductId = @ProductId
        `);
        
        if (productResult.recordset.length > 0 && productResult.recordset[0].RequiredDataFields) {
          try {
            const requiredFields = typeof productResult.recordset[0].RequiredDataFields === 'string'
              ? JSON.parse(productResult.recordset[0].RequiredDataFields)
              : productResult.recordset[0].RequiredDataFields;
            
            if (Array.isArray(requiredFields) && requiredFields.length > 0) {
              // Get the first field name (typically the configuration field like "Unshared Amount")
              configFieldName = requiredFields[0].fieldName || null;
            }
          } catch (parseError) {
            logger.warn('Could not parse RequiredDataFields for product', { productId, error: parseError.message }, 'NACHA');
          }
        }
      } catch (error) {
        logger.warn('Error fetching product RequiredDataFields', { productId, error: error.message }, 'NACHA');
      }
    }

    res.json({
      success: true,
      households,
      configFieldName, // Field name like "Unshared Amount" (only if product has configuration fields)
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount,
        totalPages: Math.ceil(totalCount / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('Error getting household details', {
      error: error.message,
      paymentId: req.params.paymentId,
      productId: req.params.productId,
      entityType: req.query.entityType,
      entityId: req.query.entityId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: 'Failed to get household details'
    });
  }
});

/**
 * GET /api/accounting/nacha/:nachaId/retry-preview
 * Returns the line items of the original NACHA, plus the recipient's CURRENT bank
 * info for each one, so the UI can let the admin pick which lines to re-issue.
 *
 * For each line we return:
 *   - The original amount (what we'll re-pay)
 *   - The original bank info snapshot (routing + last4) — what the original NACHA used
 *   - The recipient's current bank info (routing + last4) — what the retry would use
 *   - bankInfoChanged: did the recipient's default bank info change since the original?
 *   - hasCurrentBankInfo: does the recipient have any active bank info we could use?
 */
router.get('/:nachaId/retry-preview', requireTenantAccess, async (req, res) => {
  try {
    const { nachaId } = req.params;

    const accessCheck = await verifyNACHATenantAccess(nachaId, req);
    if (!accessCheck) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: NACHA file not found or belongs to a different tenant'
      });
    }

    const pool = await getPool();
    const encryptionService = require('../../services/encryptionService');
    const achService = require('../../services/ACHService');

    // 1. Pull all selected line items + the original ACH snapshot for each.
    //    For agents the original ACHAccountId is actually an oe.AgentBankInfo.BankInfoId;
    //    for vendors/tenants it's oe.ACHAccounts.ACHAccountId. Handle both.
    const linesRequest = pool.request();
    linesRequest.input('NACHAId', sql.UniqueIdentifier, nachaId);
    const linesResult = await linesRequest.query(`
      SELECT
        npd.NACHAPaymentDetailId,
        npd.PaymentId,
        npd.RecipientEntityType,
        npd.RecipientEntityId,
        npd.Amount,
        npd.ACHAccountId,
        cr.RuleName,
        ach.RoutingNumberEncrypted as ACH_RoutingNumberEncrypted,
        ach.AccountNumberLast4 as ACH_AccountNumberLast4,
        abi.RoutingNumber as ABI_RoutingNumber,
        abi.AccountNumberLast4 as ABI_AccountNumberLast4,
        abi.ModifiedDate as ABI_ModifiedDate,
        CASE 
          WHEN npd.RecipientEntityType = 'Agent' AND u.FirstName IS NOT NULL THEN ISNULL(u.FirstName, '') + ' ' + ISNULL(u.LastName, '')
          WHEN npd.RecipientEntityType = 'Agent' THEN 'Agent ' + CAST(a.AgentId AS VARCHAR(36))
          WHEN npd.RecipientEntityType = 'Agency' THEN ISNULL(ag.AgencyName, 'Agency')
          WHEN npd.RecipientEntityType = 'Vendor' THEN ISNULL(v.VendorName, 'Vendor')
          WHEN npd.RecipientEntityType = 'Tenant' THEN ISNULL(t.Name, 'Tenant')
          ELSE 'Unknown'
        END as RecipientName
      FROM oe.NACHAPaymentDetails npd
      LEFT JOIN oe.CommissionRules cr ON npd.CommissionRuleId = cr.RuleId
      LEFT JOIN oe.Agents a ON npd.RecipientEntityType = 'Agent' AND npd.RecipientEntityId = a.AgentId
      LEFT JOIN oe.Users u ON a.UserId = u.UserId
      LEFT JOIN oe.Agencies ag ON npd.RecipientEntityType = 'Agency' AND npd.RecipientEntityId = ag.AgencyId
      LEFT JOIN oe.Vendors v ON npd.RecipientEntityType = 'Vendor' AND npd.RecipientEntityId = v.VendorId
      LEFT JOIN oe.Tenants t ON npd.RecipientEntityType = 'Tenant' AND npd.RecipientEntityId = t.TenantId
      LEFT JOIN oe.ACHAccounts ach ON npd.ACHAccountId = ach.ACHAccountId
      LEFT JOIN oe.AgentBankInfo abi ON npd.RecipientEntityType = 'Agent' AND npd.ACHAccountId = abi.BankInfoId
      WHERE npd.NACHAId = @NACHAId
        AND npd.Amount > 0
      ORDER BY npd.RecipientEntityType, npd.RecipientEntityId, npd.Amount DESC
    `);

    if (linesResult.recordset.length === 0) {
      return res.json({ success: true, lines: [] });
    }

    // 2. Cache current bank info per recipient so we don't re-query for each line.
    const currentByRecipient = new Map();
    const currentKey = (r) => `${r.entityType}|${String(r.entityId).toUpperCase()}`;

    async function getCurrent(entityType, entityId) {
      const cacheKey = `${entityType}|${String(entityId).toUpperCase()}`;
      if (currentByRecipient.has(cacheKey)) return currentByRecipient.get(cacheKey);

      let info = null;
      try {
        if (entityType === 'Agent') {
          const r = pool.request();
          r.input('AgentId', sql.UniqueIdentifier, entityId);
          const result = await r.query(`
            SELECT TOP 1
              BankInfoId, BankName, AccountName, AccountType,
              RoutingNumber, AccountNumberLast4, ModifiedDate, IsDefault
            FROM oe.AgentBankInfo
            WHERE AgentId = @AgentId AND Status = 'Active'
            ORDER BY IsDefault DESC, CreatedDate DESC
          `);
          if (result.recordset.length > 0) {
            const b = result.recordset[0];
            info = {
              achAccountId: b.BankInfoId,
              bankName: b.BankName,
              accountHolderName: b.AccountName,
              accountType: b.AccountType,
              routingNumber: b.RoutingNumber || null,
              accountNumberLast4: b.AccountNumberLast4 || null,
              updatedDate: b.ModifiedDate || null
            };
          }
        } else if (entityType === 'Vendor' || entityType === 'Agency' || entityType === 'Tenant') {
          const account = await achService.getACHAccount(entityType, entityId, true);
          if (account && account.Status === 'Active') {
            info = {
              achAccountId: account.ACHAccountId,
              bankName: account.BankName,
              accountHolderName: account.AccountHolderName,
              accountType: account.AccountType,
              routingNumber: account.RoutingNumber || null,
              accountNumberLast4:
                account.AccountNumberLast4 ||
                (account.AccountNumber && typeof account.AccountNumber === 'string'
                  ? account.AccountNumber.slice(-4)
                  : null),
              updatedDate: account.ModifiedDate || null
            };
          }
        }
      } catch (e) {
        logger.warn('retry-preview: failed to load current bank info', {
          entityType,
          entityId,
          error: e.message
        }, 'NACHA');
      }

      currentByRecipient.set(cacheKey, info);
      return info;
    }

    // 3. Build per-line response.
    const lines = [];
    for (const row of linesResult.recordset) {
      // Original ACH snapshot. For agents we read AgentBankInfo (RoutingNumber is plaintext);
      // for everyone else it's oe.ACHAccounts (RoutingNumberEncrypted).
      let originalRouting = null;
      let originalLast4 = null;

      if (row.RecipientEntityType === 'Agent') {
        originalRouting = row.ABI_RoutingNumber || null;
        originalLast4 = row.ABI_AccountNumberLast4 || null;
      } else if (row.ACH_RoutingNumberEncrypted) {
        try {
          originalRouting = encryptionService.decrypt(row.ACH_RoutingNumberEncrypted);
        } catch (_) {
          originalRouting = null;
        }
        originalLast4 = row.ACH_AccountNumberLast4 || null;
      }

      const current = await getCurrent(row.RecipientEntityType, row.RecipientEntityId);

      // bankInfoChanged: routing or last4 differs (or current is missing entirely)
      const bankInfoChanged = !current
        ? false // no comparison possible — surface as "missing" instead
        : (current.routingNumber || '') !== (originalRouting || '') ||
          (current.accountNumberLast4 || '') !== (originalLast4 || '');

      lines.push({
        nachaPaymentDetailId: row.NACHAPaymentDetailId,
        paymentId: row.PaymentId,
        recipientEntityType: row.RecipientEntityType,
        recipientEntityId: row.RecipientEntityId,
        recipientName: row.RecipientName || 'Unknown',
        ruleName: row.RuleName || null,
        amount: parseFloat(row.Amount) || 0,
        original: {
          achAccountId: row.ACHAccountId,
          routingNumber: originalRouting,
          accountNumberLast4: originalLast4
        },
        current: current
          ? {
              achAccountId: current.achAccountId,
              bankName: current.bankName,
              accountHolderName: current.accountHolderName,
              accountType: current.accountType,
              routingNumber: current.routingNumber,
              accountNumberLast4: current.accountNumberLast4,
              updatedDate: current.updatedDate
            }
          : null,
        hasCurrentBankInfo: !!current,
        bankInfoChanged
      });
    }

    return res.json({
      success: true,
      lines,
      original: {
        nachaId,
        tenantId: accessCheck.TenantId
      }
    });
  } catch (error) {
    logger.error('Error building retry preview', {
      error: error.message,
      nachaId: req.params.nachaId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to build retry preview'
    });
  }
});

/**
 * POST /api/accounting/nacha/:nachaId/retry
 * Generate a new "Retry Bounces" NACHA file from selected line items on this NACHA.
 *
 * Body:
 *   paymentDetailIds:    string[]                     (required)
 *   fundingAchAccountId: string                       (required)
 *   companyIdentification: string                     (required, 9-digit EIN or 10 digits)
 */
router.post('/:nachaId/retry', requireTenantAccess, async (req, res) => {
  try {
    const { nachaId } = req.params;
    const { paymentDetailIds, fundingAchAccountId, companyIdentification } = req.body || {};

    const accessCheck = await verifyNACHATenantAccess(nachaId, req);
    if (!accessCheck) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: NACHA file not found or belongs to a different tenant'
      });
    }

    if (!Array.isArray(paymentDetailIds) || paymentDetailIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'paymentDetailIds must be a non-empty array'
      });
    }
    if (!fundingAchAccountId) {
      return res.status(400).json({
        success: false,
        message: 'fundingAchAccountId is required'
      });
    }
    if (!companyIdentification) {
      return res.status(400).json({
        success: false,
        message: 'companyIdentification is required'
      });
    }

    const result = await nachaService.generateRetryNACHA({
      originalNachaId: nachaId,
      paymentDetailIds,
      fundingAchAccountId,
      companyIdentification,
      userId: req.user.UserId
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Error generating retry NACHA', {
      error: error.message,
      nachaId: req.params.nachaId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to generate retry NACHA'
    });
  }
});

/**
 * PUT /api/accounting/nacha/:nachaId/mark-sent
 * Mark NACHA as sent (irreversible)
 */
router.put('/:nachaId/mark-sent', requireTenantAccess, async (req, res) => {
  try {
    const { nachaId } = req.params;
    
    // Verify tenant access
    const accessCheck = await verifyNACHATenantAccess(nachaId, req);
    if (!accessCheck) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: NACHA file not found or belongs to a different tenant'
      });
    }
    
    await nachaService.markNACHAasSent(nachaId, req.user.UserId);

    res.json({
      success: true,
      message: 'NACHA file marked as sent'
    });
  } catch (error) {
    logger.error('Error marking NACHA as sent', {
      error: error.message,
      nachaId: req.params.nachaId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * PUT /api/accounting/nacha/:nachaId/mark-not-sent
 * Mark NACHA as not sent (reverts mark-sent side effects)
 */
router.put('/:nachaId/mark-not-sent', requireTenantAccess, async (req, res) => {
  try {
    const { nachaId } = req.params;
    
    // Verify tenant access
    const accessCheck = await verifyNACHATenantAccess(nachaId, req);
    if (!accessCheck) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: NACHA file not found or belongs to a different tenant'
      });
    }

    await nachaService.markNACHAasNotSent(nachaId, req.user.UserId);

    res.json({
      success: true,
      message: 'NACHA file marked as not sent'
    });
  } catch (error) {
    logger.error('Error marking NACHA as not sent', {
      error: error.message,
      nachaId: req.params.nachaId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * PUT /api/accounting/nacha/mark-not-sent-by-filename
 * Mark NACHA as not sent by FileName
 * Body: { fileName: string }
 */
router.put('/mark-not-sent-by-filename', async (req, res) => {
  try {
    const { fileName } = req.body;
    if (!fileName) {
      return res.status(400).json({ success: false, message: 'fileName is required' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('FileName', sql.NVarChar, fileName);
    const result = await request.query(`
      SELECT TOP 1 NACHAId
      FROM oe.NACHAGenerations
      WHERE FileName = @FileName
      ORDER BY GeneratedDate DESC
    `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'NACHA file not found for fileName' });
    }

    const nachaId = result.recordset[0].NACHAId;
    await nachaService.markNACHAasNotSent(nachaId, req.user.UserId);

    res.json({
      success: true,
      message: 'NACHA file marked as not sent',
      nachaId
    });
  } catch (error) {
    logger.error('Error marking NACHA as not sent by filename', { error: error.message }, 'NACHA');
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/accounting/nacha/ach-details/:entityType/:entityId
 * Get ACH account details with decrypted routing and account numbers for confirmation
 */
router.get('/ach-details/:entityType/:entityId', async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    const { payoutType } = req.query; // To determine if we need ProductOverrideACH

    logger.info('Fetching ACH details', {
      entityType,
      entityId,
      payoutType
    }, 'NACHA');

    // For product owner payouts, check ProductOverrideACH table
    if (entityType === 'Tenant' && (payoutType === 'Product Owner Payouts' || payoutType === 'Product Override Distributions')) {
      const pool = await getPool();
      const request = pool.request();
      request.input('TenantId', sql.UniqueIdentifier, entityId);
      
      const overrideResult = await request.query(`
        SELECT
          OverrideACHId,
          AccountHolderName,
          BankName,
          BankAccountType,
          AccountNumberEncrypted,
          RoutingNumberEncrypted,
          IsActive,
          IsDefault,
          VerificationStatus,
          CreatedDate
        FROM oe.ProductOverrideACH
        WHERE TenantId = @TenantId
          AND IsActive = 1
        ORDER BY IsDefault DESC, CreatedDate DESC
      `);

      if (overrideResult.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No active override ACH account found'
        });
      }

      const encryptionService = require('../../services/encryptionService');
      
      const accounts = [];
      for (const account of overrideResult.recordset) {
        // Decrypt account and routing numbers
        let routingNumber = null;
        let accountNumber = null;
        let accountNumberLast4 = null;

        try {
          if (account.RoutingNumberEncrypted) {
            routingNumber = encryptionService.decrypt(account.RoutingNumberEncrypted);
          }
          if (account.AccountNumberEncrypted) {
            accountNumber = encryptionService.decrypt(account.AccountNumberEncrypted);
            if (accountNumber && typeof accountNumber === 'string' && accountNumber.length >= 4) {
              accountNumberLast4 = accountNumber.slice(-4);
            }
          }
        } catch (decryptError) {
          logger.error('Error decrypting override ACH data', {
            error: decryptError.message,
            entityId,
            overrideAchId: account.OverrideACHId
          }, 'NACHA');
          return res.status(500).json({
            success: false,
            message: 'Failed to decrypt ACH account data'
          });
        }

        accounts.push({
          achAccountId: account.OverrideACHId,
          accountHolderName: account.AccountHolderName,
          bankName: account.BankName,
          accountType: account.BankAccountType,
          routingNumber: routingNumber,
          accountNumber: accountNumber,
          accountNumberLast4: accountNumberLast4,
          distributionPercentage: account.IsDefault === true || account.IsDefault === 1 ? 100 : 0,
          isDefault: account.IsDefault === true || account.IsDefault === 1,
          verificationStatus: account.VerificationStatus,
          status: account.IsActive ? 'Active' : 'Inactive',
          // Important: NACHA generation currently uses a single default override ACH account.
          isUsedForPayout: account.IsDefault === true || account.IsDefault === 1
        });
      }

      res.json({
        success: true,
        data: {
          // Not a split distribution today; NACHA generation uses the default account.
          // We still return all active accounts so UI can warn/inspect configuration.
          isSplit: accounts.length > 1,
          totalDistribution: 100,
          accounts,
          accountSource: 'ProductOverrideACH'
        }
      });
    } else {
      // For vendors, get all active ACH accounts to show splits
      if (entityType === 'Vendor') {
        const achService = require('../../services/ACHService');
        const achAccounts = await achService.getAllACHAccounts(
          entityType,
          entityId,
          true // includeDecrypted = true
        );

        const activeAccounts = achAccounts.filter(acc => acc.Status === 'Active');
        
        if (activeAccounts.length === 0) {
          return res.status(404).json({
            success: false,
            message: 'No active ACH accounts found'
          });
        }

        // getAllACHAccounts already decrypts when includeDecrypted=true
        // It returns RoutingNumber and AccountNumber directly
        const accountsWithDecrypted = activeAccounts.map((account) => {
          return {
            achAccountId: account.ACHAccountId,
            accountHolderName: account.AccountHolderName,
            bankName: account.BankName,
            accountType: account.AccountType,
            routingNumber: account.RoutingNumber || null,
            accountNumber: account.AccountNumber || null,
            accountNumberLast4: account.AccountNumberLast4,
            distributionPercentage: Number(account.DistributionPercentage) || 0,
            isDefault: account.IsDefault === true || account.IsDefault === 1,
            verificationStatus: account.VerificationStatus,
            status: account.Status
          };
        });

        // Calculate total distribution percentage
        const totalDistribution = accountsWithDecrypted.reduce((sum, acc) => {
          return sum + (acc.distributionPercentage || 0);
        }, 0);

        res.json({
          success: true,
          data: {
            isSplit: accountsWithDecrypted.length > 1,
            totalDistribution: totalDistribution,
            accounts: accountsWithDecrypted,
            accountSource: 'ACHAccounts'
          }
        });
      } else if (entityType === 'Agent') {
        // For agents, check oe.AgentBankInfo table (not oe.ACHAccounts)
        const pool = await getPool();
        const request = pool.request();
        request.input('AgentId', sql.UniqueIdentifier, entityId);

        const bankInfoResult = await request.query(`
          SELECT TOP 1
            BankInfoId,
            AgentId,
            BankName,
            AccountName,
            AccountType,
            RoutingNumber,
            AccountNumberEncrypted,
            AccountNumberLast4,
            Status,
            IsDefault
          FROM oe.AgentBankInfo
          WHERE AgentId = @AgentId 
            AND Status = 'Active'
          ORDER BY IsDefault DESC, CreatedDate DESC
        `);

        if (bankInfoResult.recordset.length === 0) {
          return res.status(404).json({
            success: false,
            message: 'No active bank information found in oe.AgentBankInfo'
          });
        }

        const bankInfo = bankInfoResult.recordset[0];

        // Decrypt account number using smartDecryptAccountNumber, which
        // handles all three legacy storage formats produced by historical
        // bank-info paths: AES-256-GCM (correct), base64 (legacy), and
        // plaintext (legacy).
        let accountNumber = null;
        if (bankInfo.AccountNumberEncrypted) {
          try {
            const encryptionService = require('../../services/encryptionService');
            accountNumber = encryptionService.smartDecryptAccountNumber(
              bankInfo.AccountNumberEncrypted
            );
          } catch (error) {
            logger.warn('Failed to decode agent account number', {
              agentId: entityId,
              bankInfoId: bankInfo.BankInfoId,
              error: error.message
            }, 'NACHA');
            accountNumber = bankInfo.AccountNumberEncrypted;
          }
        }

        res.json({
          success: true,
          data: {
            isSplit: false,
            totalDistribution: 100,
            accounts: [{
              achAccountId: bankInfo.BankInfoId,
              accountHolderName: bankInfo.AccountName,
              bankName: bankInfo.BankName,
              accountType: bankInfo.AccountType,
              routingNumber: bankInfo.RoutingNumber, // Not encrypted in AgentBankInfo
              accountNumber: accountNumber,
              accountNumberLast4: bankInfo.AccountNumberLast4,
              distributionPercentage: 100,
              isDefault: bankInfo.IsDefault === true || bankInfo.IsDefault === 1,
              verificationStatus: null, // Not available in AgentBankInfo
              status: bankInfo.Status
            }],
            accountSource: 'AgentBankInfo'
          }
        });
      } else if (entityType === 'Tenant') {
        // For tenants, determine the ACH account that will FUND the NACHA file.
        // IMPORTANT:
        // - Vendor Payouts are funded by the tenant's PRIMARY AGENCY ACH (preferred), then fallback to tenant ACH.
        // - Agent Commission Payouts are funded by the tenant's commissions processor / TPA (when configured), then fallback to tenant ACH.
        const achService = require('../../services/ACHService');

        let achAccount = null;
        let accountSource = 'ACHAccounts';

        // Vendor Payouts: prefer primary agency ACH account
        if (payoutType === 'Vendor Payouts') {
          const pool = await getPool();
          const agencyRequest = pool.request();
          agencyRequest.input('TenantId', sql.UniqueIdentifier, entityId);

          const primaryAgencyResult = await agencyRequest.query(`
            SELECT TOP 1 AgencyId, AgencyName
            FROM oe.Agencies
            WHERE TenantId = @TenantId
              AND Status = 'Active'
              AND IsPrimary = 1
            ORDER BY CreatedDate DESC
          `);

          if (primaryAgencyResult.recordset.length > 0 && primaryAgencyResult.recordset[0].AgencyId) {
            achAccount = await achService.getACHAccount('Agency', primaryAgencyResult.recordset[0].AgencyId, true);
            accountSource = 'AgencyPrimaryACH';
          }
        }

        // Agent Commission Payouts: prefer vendor TPA service with commissions processing enabled when present
        if (!achAccount && payoutType === 'Agent Commission Payouts') {
          const pool = await getPool();
          const request = pool.request();
          request.input('TenantId', sql.UniqueIdentifier, entityId);

          const vendorTpaResult = await request.query(`
            SELECT TOP 1
              vtps.TpaAchAccountId,
              v.VendorName
            FROM oe.VendorTenantTpaServices vtps
            INNER JOIN oe.Vendors v ON vtps.VendorId = v.VendorId
            WHERE vtps.TenantId = @TenantId
              AND vtps.TpaCommissionsProcessing = 1
            ORDER BY vtps.CreatedDate DESC
          `);

          if (
            vendorTpaResult.recordset.length > 0 &&
            vendorTpaResult.recordset[0].TpaAchAccountId
          ) {
            const tpaAchAccountId = vendorTpaResult.recordset[0].TpaAchAccountId;
            const vendorName = vendorTpaResult.recordset[0].VendorName;

            logger.info('Using vendor TPA ACH account for tenant funding account', {
              tenantId: entityId,
              payoutType,
              vendorName,
              tpaAchAccountId
            }, 'NACHA');

            achAccount = await achService.getACHAccountById(tpaAchAccountId, true); // includeDecrypted = true
            accountSource = 'VendorTenantTpaServices';
          }
        }

        // Fallback: tenant ACH account in oe.ACHAccounts
        if (!achAccount || achAccount.Status !== 'Active') {
          achAccount = await achService.getACHAccount('Tenant', entityId, true); // includeDecrypted = true
          accountSource = 'ACHAccounts';
        }
        
        if (!achAccount || achAccount.Status !== 'Active') {
          return res.status(404).json({
            success: false,
            message: 'No active ACH account found for tenant'
          });
        }

        res.json({
          success: true,
          data: {
            isSplit: false,
            totalDistribution: 100,
            accounts: [{
              achAccountId: achAccount.ACHAccountId,
              accountHolderName: achAccount.AccountHolderName,
              bankName: achAccount.BankName,
              accountType: achAccount.AccountType,
              routingNumber: achAccount.RoutingNumber || null,
              accountNumber: achAccount.AccountNumber || null,
              accountNumberLast4: achAccount.AccountNumberLast4,
              companyIdentification: achAccount.CompanyIdentification || null,
              distributionPercentage: 100,
              isDefault: achAccount.IsDefault === true || achAccount.IsDefault === 1,
              verificationStatus: achAccount.VerificationStatus,
              status: achAccount.Status
            }],
            accountSource
          }
        });
      }
    }
  } catch (error) {
    logger.error('Error fetching ACH details', {
      error: error.message,
      entityType: req.params.entityType,
      entityId: req.params.entityId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: 'Failed to fetch ACH account details',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /api/accounting/nacha/ach-options/:tenantId
 * Get all available ACH account options for funding NACHA files
 * Query params: payoutType (required) - determines which accounts are available
 */
router.get('/ach-options/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const { payoutType } = req.query;

    if (!payoutType) {
      return res.status(400).json({
        success: false,
        message: 'payoutType query parameter is required'
      });
    }

    const achService = require('../../services/ACHService');
    const pool = await getPool();
    const options = [];

    logger.info('Fetching ACH options', { tenantId, payoutType }, 'NACHA');

    // Helper function to fetch TenantPayoutACH
    const fetchTenantPayoutACH = async () => {
      const tenantPayoutRequest = pool.request();
      tenantPayoutRequest.input('TenantId', sql.UniqueIdentifier, tenantId);

      const tenantPayoutResult = await tenantPayoutRequest.query(`
        SELECT TOP 1
          TenantPayoutACHId,
          AccountName,
          AccountHolderName,
          BankName,
          CompanyIdentification,
          BankAccountType,
          RoutingNumberEncrypted,
          AccountNumberEncrypted,
          IsActive,
          IsDefault
        FROM oe.TenantPayoutACH
        WHERE TenantId = @TenantId
          AND IsActive = 1
        ORDER BY IsDefault DESC, CreatedDate DESC
      `);

      if (tenantPayoutResult.recordset.length > 0) {
        const tenantAccount = tenantPayoutResult.recordset[0];
        const encryptionService = require('../../services/encryptionService');
        
        try {
          let routingNumber = null;
          let accountNumber = null;
          
          if (tenantAccount.RoutingNumberEncrypted) {
            routingNumber = encryptionService.decrypt(tenantAccount.RoutingNumberEncrypted);
          }
          if (tenantAccount.AccountNumberEncrypted) {
            accountNumber = encryptionService.decrypt(tenantAccount.AccountNumberEncrypted);
          }
          
          if (routingNumber && accountNumber) {
            // Extract last 4 digits for display
            const accountLast4 = accountNumber.replace(/\D/g, '').slice(-4);
            
            return {
              achAccountId: tenantAccount.TenantPayoutACHId,
              accountHolderName: tenantAccount.AccountHolderName,
              bankName: tenantAccount.BankName,
              accountNumberLast4: accountLast4 || null,
              accountType: tenantAccount.BankAccountType,
              label: 'Tenant Payout Account',
              isDefault: false, // Will be set based on payout type
              accountSource: 'TenantPayoutACH',
              companyIdentification: tenantAccount.CompanyIdentification || null
            };
          }
        } catch (error) {
          logger.warn('Failed to decrypt TenantPayoutACH', { error: error.message }, 'NACHA');
        }
      }
      return null;
    };

    // For Vendor Payouts: TenantPayoutACH (default), then Primary Agency ACH, then Tenant ACH
    if (payoutType === 'Vendor Payouts') {
      // First, get TenantPayoutACH (will be default for Vendor Payouts)
      const tenantPayoutACH = await fetchTenantPayoutACH();
      if (tenantPayoutACH) {
        tenantPayoutACH.isDefault = true; // Make it default for Vendor Payouts
        options.push(tenantPayoutACH);
        logger.info('Added TenantPayoutACH option (default for Vendor Payouts)', { achAccountId: tenantPayoutACH.achAccountId }, 'NACHA');
      }
      
      // Fallback: Get Primary Agency ACH
      const agencyRequest = pool.request();
      agencyRequest.input('TenantId', sql.UniqueIdentifier, tenantId);

      const primaryAgencyResult = await agencyRequest.query(`
        SELECT TOP 1 AgencyId, AgencyName
        FROM oe.Agencies
        WHERE TenantId = @TenantId
          AND Status = 'Active'
          AND IsPrimary = 1
        ORDER BY CreatedDate DESC
      `);

      if (primaryAgencyResult.recordset.length > 0 && primaryAgencyResult.recordset[0].AgencyId) {
        const agencyId = primaryAgencyResult.recordset[0].AgencyId;
        const agencyName = primaryAgencyResult.recordset[0].AgencyName;
        logger.info('Found primary agency', { agencyId, agencyName }, 'NACHA');
        try {
          const agencyACH = await achService.getACHAccount('Agency', agencyId, true);
          if (agencyACH && agencyACH.Status === 'Active') {
            options.push({
              achAccountId: agencyACH.ACHAccountId,
              accountHolderName: agencyACH.AccountHolderName,
              bankName: agencyACH.BankName,
              accountNumberLast4: agencyACH.AccountNumberLast4,
              accountType: agencyACH.AccountType,
              label: `Primary Agency: ${agencyName}`,
              isDefault: !tenantPayoutACH, // Only default if no TenantPayoutACH
              accountSource: 'AgencyPrimaryACH',
              companyIdentification: agencyACH.CompanyIdentification || null
            });
            logger.info('Added primary agency ACH option', { achAccountId: agencyACH.ACHAccountId }, 'NACHA');
          } else {
            logger.warn('Primary agency ACH not active', { agencyId, status: agencyACH?.Status }, 'NACHA');
          }
        } catch (error) {
          logger.warn('Failed to get primary agency ACH', { agencyId, error: error.message }, 'NACHA');
        }
      } else {
        logger.info('No primary agency found for tenant', { tenantId }, 'NACHA');
      }

      // Get Tenant ACH (always add as fallback option, even if same as primary agency)
      logger.info('Fetching Tenant ACH', { tenantId }, 'NACHA');
      try {
        const tenantACH = await achService.getACHAccount('Tenant', tenantId, true);
        logger.info('Tenant ACH lookup result', { 
          found: !!tenantACH, 
          status: tenantACH?.Status,
          achAccountId: tenantACH?.ACHAccountId 
        }, 'NACHA');
        
        if (tenantACH && tenantACH.Status === 'Active') {
          // Check if this is the same account as the primary agency (by ACHAccountId)
          const isSameAsPrimaryAgency = options.some(opt => 
            opt.achAccountId === tenantACH.ACHAccountId && opt.accountSource === 'AgencyPrimaryACH'
          );
          
          if (!isSameAsPrimaryAgency) {
            // Only add if it's a different account
            options.push({
              achAccountId: tenantACH.ACHAccountId,
              accountHolderName: tenantACH.AccountHolderName,
              bankName: tenantACH.BankName,
              accountNumberLast4: tenantACH.AccountNumberLast4,
              accountType: tenantACH.AccountType,
              label: 'Tenant ACH',
              isDefault: options.length === 0, // Default if no other options
              accountSource: 'ACHAccounts',
              companyIdentification: tenantACH.CompanyIdentification || null
            });
            logger.info('Added Tenant ACH option', { achAccountId: tenantACH.ACHAccountId }, 'NACHA');
          } else {
            // If same account, add it anyway but with different label to show it's also available as Tenant ACH
            options.push({
              achAccountId: tenantACH.ACHAccountId,
              accountHolderName: tenantACH.AccountHolderName,
              bankName: tenantACH.BankName,
              accountNumberLast4: tenantACH.AccountNumberLast4,
              accountType: tenantACH.AccountType,
              label: 'Tenant ACH (Same Account)',
              isDefault: false,
              accountSource: 'ACHAccounts',
              companyIdentification: tenantACH.CompanyIdentification || null
            });
            logger.info('Added Tenant ACH option (same as Primary Agency)', { achAccountId: tenantACH.ACHAccountId }, 'NACHA');
          }
        } else {
          logger.warn('Tenant ACH account not found or inactive', { tenantId, status: tenantACH?.Status }, 'NACHA');
        }
      } catch (error) {
        logger.error('Failed to get tenant ACH', { tenantId, error: error.message, stack: error.stack }, 'NACHA');
      }
    }

    // For Agent Commission Payouts: Vendor TPA ACH (default), then TenantPayoutACH, then Tenant ACH
    if (payoutType === 'Agent Commission Payouts') {
      // Get Vendor TPA ACH (commissions processing enabled) - default for Agent Commission Payouts
      const tpaRequest = pool.request();
      tpaRequest.input('TenantId', sql.UniqueIdentifier, tenantId);

      const vendorTpaResult = await tpaRequest.query(`
        SELECT TOP 1
          vtps.TpaAchAccountId,
          v.VendorName
        FROM oe.VendorTenantTpaServices vtps
        INNER JOIN oe.Vendors v ON vtps.VendorId = v.VendorId
        WHERE vtps.TenantId = @TenantId
          AND vtps.TpaCommissionsProcessing = 1
        ORDER BY vtps.CreatedDate DESC
      `);

      let hasTpa = false;
      if (vendorTpaResult.recordset.length > 0 && vendorTpaResult.recordset[0].TpaAchAccountId) {
        const tpaAchAccountId = vendorTpaResult.recordset[0].TpaAchAccountId;
        const vendorName = vendorTpaResult.recordset[0].VendorName;
        try {
          const tpaACH = await achService.getACHAccountById(tpaAchAccountId, true);
          if (tpaACH && tpaACH.Status === 'Active') {
            options.push({
              achAccountId: tpaACH.ACHAccountId,
              accountHolderName: tpaACH.AccountHolderName,
              bankName: tpaACH.BankName,
              accountNumberLast4: tpaACH.AccountNumberLast4,
              accountType: tpaACH.AccountType,
              label: `TPA: ${vendorName}`,
              isDefault: true,
              accountSource: 'VendorTenantTpaServices',
              companyIdentification: tpaACH.CompanyIdentification || null
            });
            hasTpa = true;
            logger.info('Added TPA ACH option', { achAccountId: tpaACH.ACHAccountId }, 'NACHA');
          }
        } catch (error) {
          logger.warn('Failed to get TPA ACH', { tpaAchAccountId, error: error.message }, 'NACHA');
        }
      }

      // Add TenantPayoutACH as an option (not default for Agent Commission Payouts)
      const tenantPayoutACH = await fetchTenantPayoutACH();
      if (tenantPayoutACH) {
        tenantPayoutACH.isDefault = false; // TPA is default for Agent Commission Payouts
        options.push(tenantPayoutACH);
        logger.info('Added TenantPayoutACH option', { achAccountId: tenantPayoutACH.achAccountId }, 'NACHA');
      }

      // Get Tenant ACH (always add as fallback option, even if same as TPA)
      try {
        const tenantACH = await achService.getACHAccount('Tenant', tenantId, true);
        if (tenantACH && tenantACH.Status === 'Active') {
          // Check if this is the same account as the TPA (by ACHAccountId)
          const isSameAsTpa = options.some(opt => 
            opt.achAccountId === tenantACH.ACHAccountId && opt.accountSource === 'VendorTenantTpaServices'
          );
          
          if (!isSameAsTpa) {
            // Only add if it's a different account
            options.push({
              achAccountId: tenantACH.ACHAccountId,
              accountHolderName: tenantACH.AccountHolderName,
              bankName: tenantACH.BankName,
              accountNumberLast4: tenantACH.AccountNumberLast4,
              accountType: tenantACH.AccountType,
              label: 'Tenant ACH',
              isDefault: options.length === 0, // Default if no TPA
              accountSource: 'ACHAccounts',
              companyIdentification: tenantACH.CompanyIdentification || null
            });
          } else {
            // If same account, add it anyway but with different label to show it's also available as Tenant ACH
            options.push({
              achAccountId: tenantACH.ACHAccountId,
              accountHolderName: tenantACH.AccountHolderName,
              bankName: tenantACH.BankName,
              accountNumberLast4: tenantACH.AccountNumberLast4,
              accountType: tenantACH.AccountType,
              label: 'Tenant ACH (Same Account)',
              isDefault: false,
              accountSource: 'ACHAccounts',
              companyIdentification: tenantACH.CompanyIdentification || null
            });
          }
        } else {
          logger.warn('Tenant ACH account not found or inactive', { tenantId, status: tenantACH?.Status }, 'NACHA');
        }
      } catch (error) {
        logger.warn('Failed to get tenant ACH', { tenantId, error: error.message }, 'NACHA');
      }
    }

    // For any other payout types, include TenantPayoutACH as an option
    if (payoutType !== 'Vendor Payouts' && payoutType !== 'Agent Commission Payouts') {
      const tenantPayoutACH = await fetchTenantPayoutACH();
      if (tenantPayoutACH) {
        tenantPayoutACH.isDefault = options.length === 0; // Default if no other options
        options.push(tenantPayoutACH);
        logger.info('Added TenantPayoutACH option for other payout type', { 
          payoutType, 
          achAccountId: tenantPayoutACH.achAccountId 
        }, 'NACHA');
      }
    }

    logger.info('ACH options summary', { 
      tenantId, 
      payoutType, 
      optionsCount: options.length,
      options: options.map(opt => ({ label: opt.label, accountSource: opt.accountSource, isDefault: opt.isDefault }))
    }, 'NACHA');

    if (options.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No active ACH accounts found for tenant'
      });
    }

    res.json({
      success: true,
      options
    });
  } catch (error) {
    logger.error('Error fetching ACH options', {
      error: error.message,
      tenantId: req.params.tenantId,
      payoutType: req.query.payoutType
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: 'Failed to fetch ACH account options',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /api/accounting/nacha/preview/fees
 * Get fees breakdown (SystemFees + PaymentProcessingFee) grouped by group and member
 * Query params: startDate, endDate, tenantId (optional)
 */
router.get('/preview/fees', async (req, res) => {
  try {
    const { startDate, endDate, tenantId } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'startDate and endDate query parameters are required'
      });
    }

    const { getPool, sql } = require('../../config/database');
    const pool = await getPool();
    const request = pool.request();
    
    // Convert dates to UTC with proper start/end of day
    const startDateUTC = new Date(startDate);
    startDateUTC.setUTCHours(0, 0, 0, 0);
    
    const endDateUTC = new Date(endDate);
    endDateUTC.setUTCHours(23, 59, 59, 999);

    request.input('StartDate', sql.DateTime2, startDateUTC);
    request.input('EndDate', sql.DateTime2, endDateUTC);
    
    let tenantFilter = '';
    if (tenantId) {
      request.input('TenantId', sql.UniqueIdentifier, tenantId);
      tenantFilter = `
        AND EXISTS (
          SELECT 1
          FROM oe.Enrollments e2
          INNER JOIN oe.Members m2 ON e2.MemberId = m2.MemberId
          LEFT JOIN oe.Groups g2 ON m2.GroupId = g2.GroupId
          LEFT JOIN oe.Products pr2 ON e2.ProductId = pr2.ProductId
          WHERE (p.GroupId IS NOT NULL AND m2.GroupId = p.GroupId OR p.HouseholdId IS NOT NULL AND e2.HouseholdId = p.HouseholdId)
            AND (g2.TenantId = @TenantId OR pr2.ProductOwnerId = @TenantId)
        )
      `;
    }

    const query = `
      SELECT 
        p.PaymentId,
        p.PaymentDate,
        p.GroupId,
        g.Name AS GroupName,
        CASE 
          WHEN p.GroupId IS NOT NULL THEN g.Name + ' (Group Payment)'
          ELSE COALESCE(u.FirstName + ' ' + u.LastName, 'Individual Payment')
        END AS MemberName,
        -- For group payments, sum SystemFee enrollments; for individual payments,
        -- use invoice-sourced SystemFees with payment fallback (COALESCE).
        CASE 
          WHEN p.GroupId IS NOT NULL THEN COALESCE((
            SELECT SUM(e.PremiumAmount)
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE m.GroupId = p.GroupId
              AND e.EnrollmentType = 'SystemFee'
              AND e.EffectiveDate <= p.PaymentDate
              AND (e.TerminationDate IS NULL OR e.TerminationDate > p.PaymentDate)
          ), 0)
          ELSE COALESCE(inv.SystemFees, p.SystemFees, 0)
        END AS SystemFees,
        COALESCE((
          SELECT SUM(e.PremiumAmount)
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE (p.GroupId IS NOT NULL AND m.GroupId = p.GroupId OR p.HouseholdId IS NOT NULL AND e.HouseholdId = p.HouseholdId)
            AND e.EnrollmentType = 'PaymentProcessingFee'
            AND e.EffectiveDate <= p.PaymentDate
            AND (e.TerminationDate IS NULL OR e.TerminationDate > p.PaymentDate)
        ), 0) AS ProcessingFee
      FROM oe.Payments p
      LEFT JOIN oe.Groups g ON p.GroupId = g.GroupId
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      -- Invoice-sourced payouts: prefer invoice SystemFees with payment fallback
      LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
      WHERE p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
        AND (p.NACHAId IS NULL OR p.NACHAId = '00000000-0000-0000-0000-000000000000')
        AND CAST(p.PaymentDate AS DATE) >= CAST(@StartDate AS DATE)
        AND CAST(p.PaymentDate AS DATE) <= CAST(@EndDate AS DATE)
        AND (
          -- Individual payment with SystemFees
          (p.GroupId IS NULL AND COALESCE(inv.SystemFees, p.SystemFees, 0) > 0)
          -- Group payment with SystemFee enrollments
          OR (p.GroupId IS NOT NULL AND EXISTS (
            SELECT 1
            FROM oe.Enrollments e2
            INNER JOIN oe.Members m2 ON e2.MemberId = m2.MemberId
            WHERE m2.GroupId = p.GroupId
              AND e2.EnrollmentType = 'SystemFee'
              AND e2.EffectiveDate <= p.PaymentDate
              AND (e2.TerminationDate IS NULL OR e2.TerminationDate > p.PaymentDate)
          ))
          -- PaymentProcessingFee enrollments (group or individual)
          OR EXISTS (
            SELECT 1
            FROM oe.Enrollments e3
            INNER JOIN oe.Members m3 ON e3.MemberId = m3.MemberId
            WHERE (p.GroupId IS NOT NULL AND m3.GroupId = p.GroupId OR p.HouseholdId IS NOT NULL AND e3.HouseholdId = p.HouseholdId)
              AND e3.EnrollmentType = 'PaymentProcessingFee'
              AND e3.EffectiveDate <= p.PaymentDate
              AND (e3.TerminationDate IS NULL OR e3.TerminationDate > p.PaymentDate)
          )
        )
        ${tenantFilter}
      ORDER BY p.PaymentDate DESC, g.Name, MemberName
    `;

    const result = await request.query(query);

    const fees = result.recordset.map(item => {
      const systemFees = parseFloat(item.SystemFees) || 0;
      const processingFee = parseFloat(item.ProcessingFee) || 0;
      const totalFees = systemFees + processingFee;
      
      return {
        paymentId: item.PaymentId.toString(),
        paymentDate: item.PaymentDate,
        groupId: item.GroupId ? item.GroupId.toString() : null,
        groupName: item.GroupName || null,
        memberName: item.MemberName || 'Individual Payment',
        systemFees,
        processingFee,
        totalFees
      };
    });

    // Calculate totals
    const totals = fees.reduce((acc, fee) => {
      acc.totalSystemFees += fee.systemFees;
      acc.totalProcessingFees += fee.processingFee;
      acc.totalFees += fee.totalFees;
      return acc;
    }, { totalSystemFees: 0, totalProcessingFees: 0, totalFees: 0 });

    res.json({
      success: true,
      fees,
      totals
    });
  } catch (error) {
    logger.error('Error getting fees breakdown', {
      error: error.message,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      tenantId: req.query.tenantId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: 'Failed to get fees breakdown'
    });
  }
});

/**
 * POST /api/accounting/nacha/:nachaId/send
 * Send NACHA file to a vendor destination: upload to SFTP and send notification email.
 * Body: { vendorId: string, sftpPath?: string, exportEmailAddress?: string }
 * Overrides apply only for this send; vendor settings are not updated.
 */
router.post('/:nachaId/send', requireTenantAccess, async (req, res) => {
  let tempFilePath = null;
  try {
    const { nachaId } = req.params;
    const { vendorId, sftpPath: sftpPathOverride, exportEmailAddress: exportEmailOverride } = req.body || {};

    const accessCheck = await verifyNACHATenantAccess(nachaId, req);
    if (!accessCheck) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: NACHA file not found or belongs to a different tenant'
      });
    }

    if (!vendorId) {
      return res.status(400).json({
        success: false,
        message: 'vendorId is required'
      });
    }

    const vendor = await VendorExportService.getVendorConfig(vendorId);
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor not found'
      });
    }

    if (!vendor.SftpHostname || !vendor.SftpUsername || !vendor.SftpPassword) {
      return res.status(400).json({
        success: false,
        message: 'Vendor SFTP is not fully configured (host, username, password required)'
      });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('NACHAId', sql.UniqueIdentifier, nachaId);
    const result = await request.query(`
      SELECT FileName, FileContent
      FROM oe.NACHAGenerations
      WHERE NACHAId = @NACHAId
    `);

    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'NACHA file not found'
      });
    }

    const { FileName, FileContent } = result.recordset[0];
    const sendConfig = {
      ...vendor,
      SftpPath: (sftpPathOverride != null && String(sftpPathOverride).trim() !== '') ? String(sftpPathOverride).trim() : (vendor.SftpPathNacha && vendor.SftpPathNacha.trim() !== '' ? vendor.SftpPathNacha.trim() : (vendor.SftpPath || '')),
      ExportEmailAddress: (exportEmailOverride != null && String(exportEmailOverride).trim() !== '') ? String(exportEmailOverride).trim() : (vendor.ExportEmailAddress || '')
    };

    const tempDir = path.join(__dirname, '../../temp/nacha-send');
    await fs.mkdir(tempDir, { recursive: true });
    tempFilePath = path.join(tempDir, FileName);
    const content = Buffer.isBuffer(FileContent) ? FileContent : (typeof FileContent === 'string' ? Buffer.from(FileContent, 'utf8') : Buffer.from(String(FileContent)));
    await fs.writeFile(tempFilePath, content);

    const sftpResult = await VendorExportService.uploadToSFTP(tempFilePath, sendConfig);

    const remotePath = sftpResult.remotePath || sendConfig.SftpPath || '/';
    const textContent = `The NACHA file "${FileName}" has been uploaded to the SFTP location.\n\nFile name: ${FileName}\nFolder/path: ${remotePath}\n\nThis is an automated notification from AllAboard365.`;
    const htmlContent = textContent.replace(/\n/g, '<br>\n');
    const subject = `NACHA file uploaded: ${FileName}`;
    let emailQueued = false;

    if (accessCheck.TenantId) {
      const queueOne = async (toEmail, toName) => {
        try {
          await MessageQueueService.queueEmail({
            tenantId: accessCheck.TenantId,
            toEmail,
            toName: toName || '',
            subject,
            textContent,
            htmlContent,
            messageType: 'Email',
            createdBy: req.user?.UserId || null,
            recipientId: null,
            ...MessageQueueService.billingNotificationQueueOptions(),
          });
          return true;
        } catch (emailErr) {
          logger.warn('NACHA send: failed to queue notification email', { error: emailErr.message, to: toEmail }, 'NACHA');
          return false;
        }
      };
      if (sendConfig.ExportEmailAddress) {
        emailQueued = await queueOne(sendConfig.ExportEmailAddress, '') || emailQueued;
      }
      const additionalContacts = await VendorExportService.getVendorNotificationContacts(vendorId);
      for (const c of additionalContacts) {
        if (c.email) {
          emailQueued = await queueOne(c.email, c.name) || emailQueued;
        }
      }
    }

    res.json({
      success: true,
      message: 'NACHA file sent successfully',
      data: {
        sftp: sftpResult,
        emailQueued,
        fileName: FileName,
        remotePath: sftpResult.remotePath
      }
    });
  } catch (error) {
    logger.error('Error sending NACHA', {
      error: error.message,
      nachaId: req.params.nachaId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to send NACHA file'
    });
  } finally {
    if (tempFilePath) {
      try {
        await fs.unlink(tempFilePath);
      } catch (e) {
        logger.warn('Could not remove temp NACHA file', { path: tempFilePath }, 'NACHA');
      }
    }
  }
});

/**
 * DELETE /api/accounting/nacha/:nachaId
 * Delete NACHA file (only if Pending)
 */
router.delete('/:nachaId', requireTenantAccess, async (req, res) => {
  try {
    const { nachaId } = req.params;
    
    // Verify tenant access
    const accessCheck = await verifyNACHATenantAccess(nachaId, req);
    if (!accessCheck) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: NACHA file not found or belongs to a different tenant'
      });
    }
    
    await nachaService.deleteNACHA(nachaId);

    res.json({
      success: true,
      message: 'NACHA file deleted'
    });
  } catch (error) {
    logger.error('Error deleting NACHA', {
      error: error.message,
      nachaId: req.params.nachaId
    }, 'NACHA');
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = router;

