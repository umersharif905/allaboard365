const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const requireTenantAccess = require('../../middleware/requireTenantAccess');
const { getUserRoles } = require('../../middleware/auth');
const nachaService = require('../../services/NACHAService');
const CommissionServiceAdvances = require('../../services/commissionService.advances');
const clawbackBalances = require('../../services/clawbackBalances.service');
const {
  PAID_PAYMENT_STATUSES_SQL,
  PAID_INVOICE_STATUS,
} = require('../../constants/paymentStatuses');

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

/**
 * GET /api/accounting/commission-breakdown/hold-settings
 * Returns commission hold settings + "safe" end date (today - hold window)
 * for the currently active tenant context.
 */
router.get('/commission-breakdown/hold-settings', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context missing' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('TenantId', sql.UniqueIdentifier, tenantId);
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
    console.error('Error getting commission hold settings:', error);
    res.status(500).json({ success: false, message: 'Failed to get commission hold settings' });
  }
});

/**
 * GET /api/accounting/commission-breakdown
 * Query params: startDate, endDate, groupId, individuals (optional)
 *
 * Returns agents and agencies with expectedAmount (by PaymentDate in range),
 * paidInRangeAmount (NACHA sent for those payments), paidOutAmount (NACHA GeneratedDate in range),
 * pendingPayoutAmount = expectedAmount - paidInRangeAmount.
 */
router.get('/commission-breakdown', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context missing' });
    }

    const { startDate, endDate, groupId, individuals, agentSearch, agencyId } = req.query;
    const pool = await getPool();

    // Anchor 1: Payment-anchored payments in the window (existing behavior).
    const paymentsReq = pool.request();
    paymentsReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    if (groupId && groupId !== 'all') paymentsReq.input('GroupId', sql.UniqueIdentifier, groupId);

    // Status + funding-gate aligned with NACHAService.commissions.getEligibleCommissions
    // so commission "expected" matches the rows NACHA preview will actually disburse.
    let paymentsWhere = `WHERE p.TenantId = @TenantId
      AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
      AND (p.InvoiceId IS NULL OR inv.Status = N'${PAID_INVOICE_STATUS}')`;
    if (startDate) {
      paymentsReq.input('StartDate', sql.Date, startDate);
      paymentsWhere += ` AND p.PaymentDate >= @StartDate`;
    }
    if (endDate) {
      paymentsReq.input('EndDate', sql.Date, endDate);
      paymentsWhere += ` AND p.PaymentDate < DATEADD(day, 1, @EndDate)`;
    }
    if (groupId && groupId !== 'all') {
      paymentsWhere += ` AND p.GroupId = @GroupId`;
    }
    if (individuals && individuals === 'true') {
      paymentsWhere += ` AND p.GroupId IS NULL`;
    }

    const paymentsResult = await paymentsReq.query(`
      SELECT p.PaymentId
      FROM oe.Payments p
      LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
      ${paymentsWhere}
    `);
    const payments = paymentsResult.recordset || [];
    const paymentIds = payments.map(p => p.PaymentId?.toString()).filter(Boolean);

    // Anchor 2: Invoice-anchored credit-funded invoices whose billing period overlaps
    // the window. These are oe.Invoices.Status='Paid' rows with no oe.Payments row but
    // a corresponding pending oe.Commissions row keyed by InvoiceId.
    const invoicesReq = pool.request();
    invoicesReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    if (groupId && groupId !== 'all') invoicesReq.input('GroupId', sql.UniqueIdentifier, groupId);
    // NOT EXISTS mirrors NACHAService.getUnpaidPayments Branch 2: only treat the
    // invoice as credit-anchored when no SUCCESSFUL payment row points at it.
    // Stale "Failed" / non-whitelisted rows must not block credit anchoring.
    let invoicesWhere = `
      WHERE inv.TenantId = @TenantId
        AND inv.Status = N'${PAID_INVOICE_STATUS}'
        AND NOT EXISTS (
          SELECT 1 FROM oe.Payments p
          WHERE p.InvoiceId = inv.InvoiceId
            AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
        )
    `;
    if (startDate) {
      invoicesReq.input('StartDate', sql.Date, startDate);
      invoicesWhere += ` AND COALESCE(inv.BillingPeriodEnd, DATEADD(DAY, -1, DATEADD(MONTH, 1, inv.BillingPeriodStart))) >= @StartDate`;
    }
    if (endDate) {
      invoicesReq.input('EndDate', sql.Date, endDate);
      invoicesWhere += ` AND inv.BillingPeriodStart < DATEADD(day, 1, @EndDate)`;
    }
    if (groupId && groupId !== 'all') {
      invoicesWhere += ` AND inv.GroupId = @GroupId`;
    }
    if (individuals && individuals === 'true') {
      invoicesWhere += ` AND inv.GroupId IS NULL`;
    }
    const invoicesResult = await invoicesReq.query(`
      SELECT inv.InvoiceId
      FROM oe.Invoices inv
      ${invoicesWhere}
    `);
    const invoiceIds = (invoicesResult.recordset || []).map(r => r.InvoiceId?.toString()).filter(Boolean);

    if (paymentIds.length === 0 && invoiceIds.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const paymentIdsStr = paymentIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
    const invoiceIdsStr = invoiceIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');

    // Expected amount: union of payment-anchored and invoice-anchored commissions.
    const commReq = pool.request();
    commReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    const commissionAnchorClauses = [];
    if (paymentIds.length > 0) {
      commissionAnchorClauses.push(`c.PaymentId IN (${paymentIdsStr})`);
    }
    if (invoiceIds.length > 0) {
      // Credit-funded: PaymentId IS NULL on the commission row, joined by InvoiceId.
      commissionAnchorClauses.push(`(c.PaymentId IS NULL AND c.InvoiceId IN (${invoiceIdsStr}))`);
    }
    // Group by anchor (PaymentId / InvoiceId) so step below can apply per-anchor
    // floor (matches NACHAService.commissions.commissionsToPayoutBreakdown).
    const commResult = await commReq.query(`
      SELECT
        c.AgentId,
        c.AgencyId,
        c.PaymentId,
        c.InvoiceId,
        SUM(COALESCE(c.Amount, 0)) as ExpectedAmount
      FROM oe.Commissions c
      LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
      LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
      WHERE (${commissionAnchorClauses.join(' OR ')})
        AND c.Status != 'Deleted'
        AND c.TransactionType IN ('Advance', 'Commission')
        AND (a.TenantId = @TenantId OR ag.TenantId = @TenantId)
      GROUP BY c.AgentId, c.AgencyId, c.PaymentId, c.InvoiceId
    `);

    const rows = commResult.recordset || [];
    const entityMap = new Map();
    const agentIds = new Set();
    const agencyIds = new Set();
    const ensureEntity = (key, entityType, id) => {
      if (!entityMap.has(key)) {
        entityMap.set(key, {
          entityType,
          entityId: id,
          entityName: null,
          expectedAmount: 0,
          paidInRangeAmount: 0,
          paidOutAmount: 0,
          // Per-anchor maps keyed by 'payment:<id>' / 'invoice:<id>' so the
          // breakdown's pendingPayout matches NACHA's per-anchor floor.
          expectedByAnchor: new Map(),
          paidByAnchor: new Map()
        });
      }
      return entityMap.get(key);
    };
    const anchorKeyFor = (paymentId, invoiceId) => paymentId
      ? `payment:${String(paymentId).toUpperCase()}`
      : (invoiceId ? `invoice:${String(invoiceId).toUpperCase()}` : null);

    rows.forEach(r => {
      const amt = Number(r.ExpectedAmount || 0);
      const aKey = anchorKeyFor(r.PaymentId, r.InvoiceId);
      if (r.AgentId) {
        const id = r.AgentId.toString();
        agentIds.add(id);
        const row = ensureEntity(`Agent_${id}`, 'Agent', id);
        row.expectedAmount += amt;
        if (aKey) row.expectedByAnchor.set(aKey, (row.expectedByAnchor.get(aKey) || 0) + amt);
        if (r.AgencyId && !row.agencyId) row.agencyId = r.AgencyId.toString();
      }
      if (r.AgencyId) {
        const id = r.AgencyId.toString();
        agencyIds.add(id);
        const row = ensureEntity(`Agency_${id}`, 'Agency', id);
        row.expectedAmount += amt;
        if (aKey) row.expectedByAnchor.set(aKey, (row.expectedByAnchor.get(aKey) || 0) + amt);
      }
    });

    if (entityMap.size === 0) {
      return res.json({ success: true, data: [] });
    }

    if (agentIds.size > 0) {
      const agentIdsStr = Array.from(agentIds).map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
      const nameReq = pool.request();
      const nameResult = await nameReq.query(`
        SELECT a.AgentId, ISNULL(u.FirstName + ' ' + u.LastName, 'Unknown Agent') as EntityName
        FROM oe.Agents a
        LEFT JOIN oe.Users u ON a.UserId = u.UserId
        WHERE a.AgentId IN (${agentIdsStr})
      `);
      (nameResult.recordset || []).forEach(r => {
        const key = `Agent_${r.AgentId.toString()}`;
        const row = entityMap.get(key);
        if (row) row.entityName = r.EntityName || 'Unknown Agent';
      });
    }
    if (agencyIds.size > 0) {
      const agencyIdsStr = Array.from(agencyIds).map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
      const nameReq = pool.request();
      const nameResult = await nameReq.query(`
        SELECT AgencyId, ISNULL(AgencyName, 'Unknown Agency') as EntityName
        FROM oe.Agencies
        WHERE AgencyId IN (${agencyIdsStr})
      `);
      (nameResult.recordset || []).forEach(r => {
        const key = `Agency_${r.AgencyId.toString()}`;
        const row = entityMap.get(key);
        if (row) row.entityName = r.EntityName || 'Unknown Agency';
      });
    }

    // paidInRange: NACHA details whose anchor (PaymentId or InvoiceId) falls within the
    // window's anchor sets. Pre-shift this only matched npd.PaymentId, which silently
    // dropped any NACHA detail row stamped with InvoiceId only (credit-funded payouts).
    const paidInRangeAnchorClauses = [];
    if (paymentIds.length > 0) {
      paidInRangeAnchorClauses.push(`npd.PaymentId IN (${paymentIdsStr})`);
    }
    if (invoiceIds.length > 0) {
      paidInRangeAnchorClauses.push(`npd.InvoiceId IN (${invoiceIdsStr})`);
    }
    const paidInRangeResult = await pool.request().query(`
      SELECT
        npd.RecipientEntityType as EntityType,
        npd.RecipientEntityId as EntityId,
        npd.PaymentId,
        npd.InvoiceId,
        SUM(COALESCE(npd.Amount, 0)) as PaidAmount
      FROM oe.NACHAPaymentDetails npd
      INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
      WHERE npd.RecipientEntityType IN ('Agent', 'Agency')
        AND ng.Status = 'Sent'
        AND ng.PayoutType = 'Agent Commission Payouts'
        AND (${paidInRangeAnchorClauses.join(' OR ')})
      GROUP BY npd.RecipientEntityType, npd.RecipientEntityId, npd.PaymentId, npd.InvoiceId
    `);
    (paidInRangeResult.recordset || []).forEach(r => {
      const key = `${r.EntityType}_${r.EntityId.toString()}`;
      const row = entityMap.get(key);
      if (!row) return;
      const amt = Number(r.PaidAmount || 0);
      row.paidInRangeAmount += amt;
      const aKey = anchorKeyFor(r.PaymentId, r.InvoiceId);
      if (aKey) row.paidByAnchor.set(aKey, (row.paidByAnchor.get(aKey) || 0) + amt);
    });

    const paidOutReq = pool.request();
    paidOutReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    let generatedWhere = `WHERE ng.TenantId = @TenantId AND ng.Status = 'Sent' AND ng.PayoutType = 'Agent Commission Payouts'`;
    if (startDate) {
      paidOutReq.input('StartDate', sql.Date, startDate);
      generatedWhere += ` AND ng.GeneratedDate >= @StartDate`;
    }
    if (endDate) {
      paidOutReq.input('EndDate', sql.Date, endDate);
      generatedWhere += ` AND ng.GeneratedDate < DATEADD(day, 1, @EndDate)`;
    }
    const paidOutResult = await paidOutReq.query(`
      SELECT
        npd.RecipientEntityType as EntityType,
        npd.RecipientEntityId as EntityId,
        SUM(COALESCE(npd.Amount, 0)) as PaidOutAmount
      FROM oe.NACHAPaymentDetails npd
      INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
      ${generatedWhere}
        AND npd.RecipientEntityType IN ('Agent', 'Agency')
      GROUP BY npd.RecipientEntityType, npd.RecipientEntityId
    `);
    (paidOutResult.recordset || []).forEach(r => {
      const key = `${r.EntityType}_${r.EntityId.toString()}`;
      const row = entityMap.get(key);
      if (row) row.paidOutAmount += Number(r.PaidOutAmount || 0);
    });

    // Pending clawback per recipient (oe.Commissions negatives still in 'Pending').
    // These will net against the next NACHA cycle's positive payout.
    const recipientList = Array.from(entityMap.values()).map((row) => ({
      entityType: row.entityType,
      entityId: row.entityId
    }));
    let clawbackMap = new Map();
    try {
      clawbackMap = await clawbackBalances.getCommissionClawbackBalances({
        tenantId,
        recipients: recipientList
      });
    } catch (e) {
      console.warn('commission-breakdown: clawback lookup failed', e.message);
    }

    const data = Array.from(entityMap.values()).map(row => {
      const expected = Math.round((row.expectedAmount || 0) * 100) / 100;
      const paidInRange = Math.round((row.paidInRangeAmount || 0) * 100) / 100;
      const paidOut = Math.round((row.paidOutAmount || 0) * 100) / 100;
      // Per-anchor floor: SUM over anchors of MAX(0, expected_i - paid_i).
      // Mirrors NACHAService.commissions.commissionsToPayoutBreakdown so the
      // breakdown row matches what NACHA preview will pay this entity.
      const anchorKeys = new Set([
        ...row.expectedByAnchor.keys(),
        ...row.paidByAnchor.keys()
      ]);
      let pendingPayoutRaw = 0;
      anchorKeys.forEach(k => {
        const exp = Number(row.expectedByAnchor.get(k) || 0);
        const pd = Number(row.paidByAnchor.get(k) || 0);
        if (exp > pd) pendingPayoutRaw += (exp - pd);
      });
      const pendingPayout = Math.round(pendingPayoutRaw * 100) / 100;
      const cb = clawbackMap.get(`${row.entityType}_${row.entityId}`);
      const pendingClawback = cb ? Math.round((cb.amount || 0) * 100) / 100 : 0;
      const netNextPayout = Math.round(Math.max(0, pendingPayout - pendingClawback) * 100) / 100;
      return {
        entityType: row.entityType,
        entityId: row.entityId,
        entityName: row.entityName || (row.entityType === 'Agent' ? 'Unknown Agent' : 'Unknown Agency'),
        agencyId: row.agencyId || null,
        expectedAmount: expected,
        paidInRangeAmount: paidInRange,
        paidOutAmount: paidOut,
        pendingPayoutAmount: pendingPayout,
        pendingClawbackAmount: pendingClawback,
        pendingClawbackCount: cb ? Number(cb.count || 0) : 0,
        netNextPayoutAmount: netNextPayout
      };
    });

    let filtered = data;
    if (agentSearch && String(agentSearch).trim()) {
      const q = String(agentSearch).trim().toLowerCase();
      filtered = filtered.filter(r => (r.entityName || '').toLowerCase().includes(q));
    }
    if (agencyId && agencyId !== 'all') {
      filtered = filtered.filter(r =>
        r.entityType === 'Agency' ? r.entityId === agencyId : r.agencyId === agencyId
      );
    }

    res.json({ success: true, data: filtered });
  } catch (error) {
    console.error('Error building commission breakdown:', error);
    res.status(500).json({ success: false, message: 'Failed to build commission breakdown' });
  }
});

/**
 * GET /api/accounting/commission-breakdown/filter-options
 * Query params: startDate, endDate, entityId (optional), entityType (optional)
 *
 * Returns groups and individuals that have commission activity in the date range.
 * When entityId/entityType provided, scope to that agent/agency for modal.
 */
router.get('/commission-breakdown/filter-options', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context missing' });
    }

    const { startDate, endDate, entityId, entityType } = req.query;
    const pool = await getPool();
    const filterReq = pool.request();
    filterReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    if (startDate) filterReq.input('StartDate', sql.Date, startDate);
    if (endDate) filterReq.input('EndDate', sql.Date, endDate);
    if (entityId) filterReq.input('EntityId', sql.UniqueIdentifier, entityId);
    if (entityType) filterReq.input('EntityType', sql.NVarChar(50), entityType);

    const entityFilter = entityId && entityType
      ? `AND ((@EntityType = 'Agent' AND c.AgentId = @EntityId) OR (@EntityType = 'Agency' AND c.AgencyId = @EntityId))`
      : '';

    // Branch 1: payment-anchored. Funding-gate via subquery so callers don't
    // have to JOIN oe.Invoices into every consuming query.
    const paymentFilterWhere = `
      WHERE p.TenantId = @TenantId
        AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
        AND (
          p.InvoiceId IS NULL
          OR EXISTS (SELECT 1 FROM oe.Invoices invFG WHERE invFG.InvoiceId = p.InvoiceId AND invFG.Status = N'${PAID_INVOICE_STATUS}')
        )
        ${startDate ? 'AND p.PaymentDate >= @StartDate' : ''}
        ${endDate ? 'AND p.PaymentDate < DATEADD(day, 1, @EndDate)' : ''}
        AND c.Status != 'Deleted'
        AND c.TransactionType IN ('Advance', 'Commission')
        AND (a.TenantId = @TenantId OR ag.TenantId = @TenantId)
        ${entityFilter}
    `;

    // Branch 2: invoice-anchored (credit-funded). Includes invoices whose billing
    // period overlaps the window when there's no oe.Payments row (PaymentId IS NULL
    // on the commission row).
    const invoiceFilterWhere = `
      WHERE inv.TenantId = @TenantId
        AND inv.Status = N'Paid'
        AND c.PaymentId IS NULL
        AND c.InvoiceId IS NOT NULL
        ${startDate ? 'AND COALESCE(inv.BillingPeriodEnd, DATEADD(DAY, -1, DATEADD(MONTH, 1, inv.BillingPeriodStart))) >= @StartDate' : ''}
        ${endDate ? 'AND inv.BillingPeriodStart < DATEADD(day, 1, @EndDate)' : ''}
        AND c.Status != 'Deleted'
        AND c.TransactionType IN ('Advance', 'Commission')
        AND (a.TenantId = @TenantId OR ag.TenantId = @TenantId)
        ${entityFilter}
    `;

    const groupsResult = await filterReq.query(`
      SELECT DISTINCT id, label, type FROM (
        SELECT DISTINCT
          p.GroupId as id,
          g.Name as label,
          'group' as type
        FROM oe.Payments p
        INNER JOIN oe.Commissions c ON c.PaymentId = p.PaymentId
        LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
        LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
        INNER JOIN oe.Members m ON m.GroupId = p.GroupId AND m.TenantId = p.TenantId
        LEFT JOIN oe.Groups g ON p.GroupId = g.GroupId
        ${paymentFilterWhere}
          AND p.GroupId IS NOT NULL
          AND g.Name IS NOT NULL

        UNION

        SELECT DISTINCT
          inv.GroupId as id,
          g.Name as label,
          'group' as type
        FROM oe.Invoices inv
        INNER JOIN oe.Commissions c ON c.InvoiceId = inv.InvoiceId AND c.PaymentId IS NULL
        LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
        LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
        INNER JOIN oe.Members m ON m.GroupId = inv.GroupId AND m.TenantId = inv.TenantId
        LEFT JOIN oe.Groups g ON inv.GroupId = g.GroupId
        ${invoiceFilterWhere}
          AND inv.GroupId IS NOT NULL
          AND g.Name IS NOT NULL
      ) gx
      ORDER BY label
    `);

    const hasIndividualsResult = await filterReq.query(`
      SELECT TOP 1 1 as hasIndividuals FROM (
        SELECT 1 as flag
        FROM oe.Payments p
        INNER JOIN oe.Commissions c ON c.PaymentId = p.PaymentId
        LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
        LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
        ${paymentFilterWhere}
          AND p.HouseholdId IS NOT NULL
          AND p.GroupId IS NULL

        UNION ALL

        SELECT 1 as flag
        FROM oe.Invoices inv
        INNER JOIN oe.Commissions c ON c.InvoiceId = inv.InvoiceId AND c.PaymentId IS NULL
        LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
        LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
        ${invoiceFilterWhere}
          AND inv.HouseholdId IS NOT NULL
          AND inv.GroupId IS NULL
      ) ix
    `);
    const hasIndividuals = hasIndividualsResult.recordset.length > 0;

    const options = [
      { id: 'all', label: 'All Group & Member Payments', type: 'all', value: 'all' },
      ...(groupsResult.recordset || []).map(g => ({ ...g, value: `group_${g.id}` })),
      ...(hasIndividuals ? [{ id: 'individuals', label: 'Individuals', type: 'individuals', value: 'individuals' }] : [])
    ];

    res.json({ success: true, data: options });
  } catch (error) {
    console.error('Error getting commission filter options:', error);
    res.status(500).json({ success: false, message: 'Failed to get filter options' });
  }
});

/**
 * GET /api/accounting/commission-breakdown/payments
 * Query params: entityType, entityId, startDate, endDate, groupId, householdId, individuals (optional)
 *
 * Returns payment rows (date/payment/client/agent + entity commission total per payment)
 * for use in the accounting drilldown modal.
 */
router.get('/commission-breakdown/payments', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context missing' });
    }
    const { entityType, entityId, startDate, endDate, groupId, householdId, individuals } = req.query;
    if (!entityType || !entityId) {
      return res.status(400).json({ success: false, message: 'entityType and entityId are required' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('TenantId', sql.UniqueIdentifier, tenantId);
    request.input('EntityId', sql.UniqueIdentifier, entityId);
    if (startDate) request.input('StartDate', sql.Date, startDate);
    if (endDate) request.input('EndDate', sql.Date, endDate);
    if (groupId && groupId !== 'all') request.input('GroupId', sql.UniqueIdentifier, groupId);
    if (householdId && householdId !== 'all') request.input('HouseholdId', sql.UniqueIdentifier, householdId);

    const entityCondition = entityType === 'Agent'
      ? 'c.AgentId = @EntityId AND c.AgencyId IS NULL'
      : 'c.AgencyId = @EntityId';

    // Branch 1: payment-anchored. Funding-gate via subquery so we don't have
    // to inject another JOIN into every consuming SELECT.
    let pwhere = `
      WHERE p.TenantId = @TenantId
        AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
        AND (
          p.InvoiceId IS NULL
          OR EXISTS (SELECT 1 FROM oe.Invoices invFG WHERE invFG.InvoiceId = p.InvoiceId AND invFG.Status = N'${PAID_INVOICE_STATUS}')
        )
        AND c.Status != 'Deleted'
        AND c.TransactionType IN ('Advance', 'Commission')
        AND ${entityCondition}
        AND (a.TenantId = @TenantId OR ag.TenantId = @TenantId)
    `;
    if (startDate) pwhere += ' AND p.PaymentDate >= @StartDate';
    if (endDate) pwhere += ' AND p.PaymentDate < DATEADD(day, 1, @EndDate)';
    if (groupId && groupId !== 'all') pwhere += ' AND p.GroupId = @GroupId';
    if (householdId && householdId !== 'all') pwhere += ' AND p.HouseholdId = @HouseholdId';
    if (individuals === 'true') pwhere += ' AND p.GroupId IS NULL';

    // Branch 2: invoice-anchored credit-funded (PaymentId IS NULL).
    let iwhere = `
      WHERE inv.TenantId = @TenantId
        AND inv.Status = N'Paid'
        AND c.PaymentId IS NULL
        AND c.InvoiceId IS NOT NULL
        AND c.Status != 'Deleted'
        AND c.TransactionType IN ('Advance', 'Commission')
        AND ${entityCondition}
        AND (a.TenantId = @TenantId OR ag.TenantId = @TenantId)
    `;
    if (startDate) iwhere += ' AND COALESCE(inv.BillingPeriodEnd, DATEADD(DAY, -1, DATEADD(MONTH, 1, inv.BillingPeriodStart))) >= @StartDate';
    if (endDate) iwhere += ' AND inv.BillingPeriodStart < DATEADD(day, 1, @EndDate)';
    if (groupId && groupId !== 'all') iwhere += ' AND inv.GroupId = @GroupId';
    if (householdId && householdId !== 'all') iwhere += ' AND inv.HouseholdId = @HouseholdId';
    if (individuals === 'true') iwhere += ' AND inv.GroupId IS NULL';

    const result = await request.query(`
      -- Payment-anchored rows
      SELECT
        p.PaymentId,
        CAST(NULL AS UNIQUEIDENTIFIER) AS InvoiceId,
        p.PaymentDate,
        p.Amount AS PaymentAmount,
        SUM(COALESCE(c.Amount, 0)) AS CommissionAmount,
        ISNULL(au.FirstName + ' ' + au.LastName, 'Unknown Agent') AS AgentName,
        CASE
          WHEN p.GroupId IS NOT NULL THEN ISNULL(g.Name, 'Unknown Group')
          ELSE ISNULL(cu.FirstName + ' ' + cu.LastName, 'Unknown Member')
        END AS ClientName,
        CAST(0 AS BIT) AS IsCreditFunded
      FROM oe.Payments p
      INNER JOIN oe.Commissions c ON c.PaymentId = p.PaymentId
      LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
      LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
      LEFT JOIN oe.Agents pa ON p.AgentId = pa.AgentId
      LEFT JOIN oe.Users au ON pa.UserId = au.UserId
      LEFT JOIN oe.Groups g ON p.GroupId = g.GroupId
      LEFT JOIN oe.Members hm ON hm.HouseholdId = p.HouseholdId AND hm.RelationshipType = 'P'
      LEFT JOIN oe.Users cu ON hm.UserId = cu.UserId
      ${pwhere}
      GROUP BY
        p.PaymentId, p.PaymentDate, p.Amount,
        au.FirstName, au.LastName,
        g.Name, cu.FirstName, cu.LastName, p.GroupId

      UNION ALL

      -- Invoice-anchored credit-funded rows. Pre-shift this entire branch was
      -- missing, so credit-funded commissions silently dropped from the modal.
      -- Agent name comes from the group (for group invoices) or the household
      -- primary member (for individual invoices) since oe.Invoices has no
      -- AgentId column.
      SELECT
        CAST(NULL AS UNIQUEIDENTIFIER) AS PaymentId,
        inv.InvoiceId,
        inv.BillingPeriodStart AS PaymentDate,
        inv.TotalAmount AS PaymentAmount,
        SUM(COALESCE(c.Amount, 0)) AS CommissionAmount,
        ISNULL(au.FirstName + ' ' + au.LastName, 'Unknown Agent') AS AgentName,
        CASE
          WHEN inv.GroupId IS NOT NULL THEN ISNULL(g.Name, 'Unknown Group')
          ELSE ISNULL(cu.FirstName + ' ' + cu.LastName, 'Unknown Member')
        END AS ClientName,
        CAST(1 AS BIT) AS IsCreditFunded
      FROM oe.Invoices inv
      INNER JOIN oe.Commissions c ON c.InvoiceId = inv.InvoiceId AND c.PaymentId IS NULL
      LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
      LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
      LEFT JOIN oe.Groups g ON inv.GroupId = g.GroupId
      LEFT JOIN oe.Members hm ON hm.HouseholdId = inv.HouseholdId AND hm.RelationshipType = 'P'
      LEFT JOIN oe.Users cu ON hm.UserId = cu.UserId
      LEFT JOIN oe.Agents pa ON pa.AgentId = COALESCE(g.AgentId, hm.AgentId)
      LEFT JOIN oe.Users au ON pa.UserId = au.UserId
      ${iwhere}
      GROUP BY
        inv.InvoiceId, inv.BillingPeriodStart, inv.TotalAmount,
        au.FirstName, au.LastName,
        g.Name, cu.FirstName, cu.LastName, inv.GroupId

      ORDER BY PaymentDate DESC
    `);

    const data = (result.recordset || []).map((r) => ({
      paymentId: r.PaymentId ? r.PaymentId.toString() : null,
      invoiceId: r.InvoiceId ? r.InvoiceId.toString() : null,
      isCreditFunded: !!r.IsCreditFunded,
      paymentDate: r.PaymentDate,
      paymentAmount: Math.round(Number(r.PaymentAmount || 0) * 100) / 100,
      commissionAmount: Math.round(Number(r.CommissionAmount || 0) * 100) / 100,
      agentName: r.AgentName || 'Unknown Agent',
      clientName: r.ClientName || 'Unknown'
    }));

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error getting commission breakdown payment list:', error);
    res.status(500).json({ success: false, message: 'Failed to get breakdown payment list' });
  }
});

/**
 * GET /api/accounting/commission-breakdown/payment/:paymentId
 *
 * Returns per-product payout breakdown for an existing payment (allows posted commissions).
 */
router.get('/commission-breakdown/payment/:paymentId', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    const { paymentId } = req.params;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context missing' });
    }

    const pool = await getPool();
    const check = await pool.request()
      .input('PaymentId', sql.UniqueIdentifier, paymentId)
      .input('TenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT 1
        FROM oe.Payments p
        INNER JOIN oe.Agents a ON p.AgentId = a.AgentId
        WHERE p.PaymentId = @PaymentId
          AND a.TenantId = @TenantId
      `);
    if (!check.recordset?.length) {
      return res.status(403).json({ success: false, message: 'Payment not found or access denied' });
    }

    const data = await CommissionServiceAdvances.getPaymentBreakdownPreview(paymentId, {
      allowExistingCommissions: true
    });
    if (!data) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error getting commission breakdown payment details:', error);
    res.status(500).json({ success: false, message: 'Failed to get payment breakdown details' });
  }
});

/**
 * GET /api/accounting/commission-breakdown/breakdown
 * Query params: entityType, entityId, startDate, endDate, groupId, householdId, individuals (optional)
 *
 * Returns product-by-product breakdown with tiers for the selected agent or agency.
 * Uses CommissionServiceAdvances.getPaymentBreakdownPreview (same path as preview Details),
 * then reconciles to oe.Commissions totals for the selected scope.
 */
router.get('/commission-breakdown/breakdown', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context missing' });
    }

    const { entityType, entityId, startDate, endDate, groupId, householdId, individuals } = req.query;
    if (!entityType || !entityId) {
      return res.status(400).json({ success: false, message: 'entityType and entityId are required' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('TenantId', sql.UniqueIdentifier, tenantId);
    request.input('EntityId', sql.UniqueIdentifier, entityId);
    request.input('EntityType', sql.NVarChar(50), entityType);
    if (startDate) request.input('StartDate', sql.Date, startDate);
    if (endDate) request.input('EndDate', sql.Date, endDate);
    if (groupId && groupId !== 'all') request.input('GroupId', sql.UniqueIdentifier, groupId);
    if (householdId && householdId !== 'all') request.input('HouseholdId', sql.UniqueIdentifier, householdId);

    const entityCondition = entityType === 'Agent'
      ? 'c.AgentId = @EntityId AND c.AgencyId IS NULL'
      : 'c.AgencyId = @EntityId';
    let pwhere = `
      WHERE p.TenantId = @TenantId
        AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
        AND (
          p.InvoiceId IS NULL
          OR EXISTS (SELECT 1 FROM oe.Invoices invFG WHERE invFG.InvoiceId = p.InvoiceId AND invFG.Status = N'${PAID_INVOICE_STATUS}')
        )
        AND c.Status != 'Deleted'
        AND c.TransactionType IN ('Advance', 'Commission')
        AND ${entityCondition}
        AND (a.TenantId = @TenantId OR ag.TenantId = @TenantId)
    `;
    if (startDate) pwhere += ' AND p.PaymentDate >= @StartDate';
    if (endDate) pwhere += ' AND p.PaymentDate < DATEADD(day, 1, @EndDate)';
    if (groupId && groupId !== 'all') pwhere += ' AND p.GroupId = @GroupId';
    if (householdId && householdId !== 'all') pwhere += ' AND p.HouseholdId = @HouseholdId';
    if (individuals === 'true') pwhere += ' AND p.GroupId IS NULL';

    // Invoice-anchored credit-funded sums for the same window/scope. We pull
    // the totals here so the source-of-truth grand total below includes credit-
    // funded commissions even though the per-product preview path is payment-only.
    let iwhere = `
      WHERE inv.TenantId = @TenantId
        AND inv.Status = N'Paid'
        AND c.PaymentId IS NULL
        AND c.InvoiceId IS NOT NULL
        AND c.Status != 'Deleted'
        AND c.TransactionType IN ('Advance', 'Commission')
        AND ${entityCondition}
        AND (a.TenantId = @TenantId OR ag.TenantId = @TenantId)
    `;
    if (startDate) iwhere += ' AND COALESCE(inv.BillingPeriodEnd, DATEADD(DAY, -1, DATEADD(MONTH, 1, inv.BillingPeriodStart))) >= @StartDate';
    if (endDate) iwhere += ' AND inv.BillingPeriodStart < DATEADD(day, 1, @EndDate)';
    if (groupId && groupId !== 'all') iwhere += ' AND inv.GroupId = @GroupId';
    if (householdId && householdId !== 'all') iwhere += ' AND inv.HouseholdId = @HouseholdId';
    if (individuals === 'true') iwhere += ' AND inv.GroupId IS NULL';

    // Payment list and source-of-truth totals from oe.Commissions (this is what table rows use).
    const paymentRowsResult = await request.query(`
      SELECT
        p.PaymentId,
        SUM(COALESCE(c.Amount, 0)) AS EntityPaymentCommission
      FROM oe.Payments p
      INNER JOIN oe.Commissions c ON c.PaymentId = p.PaymentId
      LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
      LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
      ${pwhere}
      GROUP BY p.PaymentId
    `);

    const invoiceCommissionTotalResult = await request.query(`
      SELECT
        SUM(COALESCE(c.Amount, 0)) AS InvoiceCommissionTotal
      FROM oe.Invoices inv
      INNER JOIN oe.Commissions c ON c.InvoiceId = inv.InvoiceId AND c.PaymentId IS NULL
      LEFT JOIN oe.Agents a ON c.AgentId = a.AgentId
      LEFT JOIN oe.Agencies ag ON c.AgencyId = ag.AgencyId
      ${iwhere}
    `);
    const invoiceCreditFundedTotal = Number(invoiceCommissionTotalResult.recordset?.[0]?.InvoiceCommissionTotal || 0);

    const paymentRows = paymentRowsResult.recordset || [];
    if (paymentRows.length === 0 && invoiceCreditFundedTotal === 0) {
      return res.json({ success: true, data: [] });
    }

    const entityIdNorm = String(entityId).toLowerCase();
    const productMap = new Map(); // productName -> { productId, productName, tierMap, totalCommission }
    let sourceTotal = 0;

    for (const row of paymentRows) {
      const paymentId = row.PaymentId ? row.PaymentId.toString() : null;
      if (!paymentId) continue;
      sourceTotal += Number(row.EntityPaymentCommission || 0);

      const preview = await CommissionServiceAdvances.getPaymentBreakdownPreview(paymentId, {
        allowExistingCommissions: true
      });
      if (!preview?.products?.length) continue;

      for (const product of preview.products) {
        const productName = product.productName || 'Unknown Product';
        const productId = product.productId || null;
        if (!productMap.has(productName)) {
          productMap.set(productName, {
            productId,
            productName,
            tierMap: new Map(), // tier -> { enrollmentCount, totalCommission }
            totalCommission: 0
          });
        }
        const productEntry = productMap.get(productName);

        for (const payoutRow of (product.breakdown || [])) {
          const recipientAgentId = payoutRow.recipientAgentId ? String(payoutRow.recipientAgentId).toLowerCase() : null;
          const recipientAgencyId = payoutRow.recipientAgencyId ? String(payoutRow.recipientAgencyId).toLowerCase() : null;
          const isMatch = entityType === 'Agent'
            ? recipientAgentId === entityIdNorm
            : recipientAgencyId === entityIdNorm;
          if (!isMatch) continue;

          const amount = Number(payoutRow.amount || 0);
          if (!Number.isFinite(amount) || amount === 0) continue;
          const tierName = payoutRow.tierLevel != null ? `Level ${payoutRow.tierLevel}` : 'Standard';
          if (!productEntry.tierMap.has(tierName)) {
            productEntry.tierMap.set(tierName, { enrollmentCount: 0, totalCommission: 0 });
          }
          const tier = productEntry.tierMap.get(tierName);
          tier.enrollmentCount += 1;
          tier.totalCommission += amount;
          productEntry.totalCommission += amount;
        }
      }
    }

    // Add credit-funded invoice commissions to the source total. The per-product
    // breakdown path uses getPaymentBreakdownPreview which is payment-only, so
    // credit-funded portions land in the Adjustment row below until/unless an
    // equivalent invoice-anchored preview path is added.
    sourceTotal += invoiceCreditFundedTotal;

    let calculatedTotal = 0;
    const data = Array.from(productMap.values())
      .map((product) => {
        const tiers = Array.from(product.tierMap.entries())
          .map(([pricingTier, tier]) => {
            const totalCommission = Math.round((tier.totalCommission || 0) * 100) / 100;
            const enrollmentCount = tier.enrollmentCount || 0;
            const commissionAmount = enrollmentCount > 0
              ? Math.round((totalCommission / enrollmentCount) * 100) / 100
              : 0;
            return {
              productPricingId: null,
              pricingTier,
              enrollmentCount,
              commissionAmount,
              totalCommission
            };
          })
          .sort((a, b) => (a.pricingTier || '').localeCompare(b.pricingTier || ''));
        const totalCommission = Math.round((product.totalCommission || 0) * 100) / 100;
        calculatedTotal += totalCommission;
        return {
          productId: product.productId,
          productName: product.productName,
          tiers,
          totalCommission
        };
      })
      .sort((a, b) => (a.productName || '').localeCompare(b.productName || ''));

    // Safety: keep modal grand total aligned to oe.Commissions table total for the selected entity/date/filter.
    const roundedSourceTotal = Math.round(sourceTotal * 100) / 100;
    const delta = Math.round((roundedSourceTotal - calculatedTotal) * 100) / 100;
    if (Math.abs(delta) >= 0.01) {
      data.push({
        productId: null,
        productName: 'Unmapped / Adjustment',
        tiers: [{
          productPricingId: null,
          pricingTier: 'Adjustment',
          enrollmentCount: 1,
          commissionAmount: delta,
          totalCommission: delta
        }],
        totalCommission: delta
      });
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error building commission breakdown details:', error);
    res.status(500).json({ success: false, message: 'Failed to build commission breakdown details' });
  }
});

/**
 * GET /api/accounting/commission-breakdown/export-details
 * Query params: entityType, entityId, startDate, endDate, groupId, householdId, individuals
 *
 * Returns NACHA-shaped export (summary, payments, groups, individuals, products) for XLSX.
 * Uses same ProductCommissions + CommissionRules flat-amount logic as NACHA export.
 */
router.get('/commission-breakdown/export-details', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context missing' });
    }
    const { entityType, entityId, startDate, endDate, groupId, householdId, individuals } = req.query;
    if (!entityType || !entityId) {
      return res.status(400).json({ success: false, message: 'entityType and entityId are required' });
    }
    const options = {};
    if (groupId && groupId !== 'all') options.groupId = groupId;
    if (householdId && householdId !== 'all') options.householdId = householdId;
    if (individuals === 'true') options.individuals = 'true';

    const data = await nachaService.getExportDetailsForAccountant(
      tenantId,
      entityType,
      entityId,
      startDate || null,
      endDate || null,
      options
    );
    res.json({ success: true, ...data });
  } catch (error) {
    console.error('Error getting commission breakdown export details:', error);
    res.status(500).json({ success: false, message: 'Failed to get export details' });
  }
});

module.exports = router;
