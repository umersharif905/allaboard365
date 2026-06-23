const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { authorize, getUserRoles } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const { buildSellingAgentPaymentFilter } = require('../../../utils/sellingAgentPaymentFilter');
const { buildCommissionOwnerFilter } = require('../../../utils/commissionOwnerFilter');
const CommissionServiceAdvances = require('../../../services/commissionService.advances');
const { redactPaymentBreakdownForAgent } = require('../../../utils/redactAgentCommissionBreakdown');
const { getSelfAndDownlineAgentIds, isUplineAncestor } = require('../../../utils/agentHierarchy');
const agencyAdmins = require('../../../utils/agencyAdmins');

const getUserId = (req) => req.user?.UserId || req.user?.userId;

async function getAgentContext(req) {
  const userId = getUserId(req);
  if (!userId) return null;

  const pool = await getPool();
  const request = pool.request();
  request.input('userId', sql.UniqueIdentifier, userId);

  const result = await request.query(`
    SELECT AgentId, AgencyId
    FROM oe.Agents
    WHERE UserId = @userId
      AND Status = 'Active'
  `);

  const row = result.recordset?.[0];
  if (!row?.AgentId) return null;

  return {
    pool,
    userId,
    viewerAgentId: row.AgentId,
    agencyId: row.AgencyId || null
  };
}

/**
 * GET /api/me/agent/payments/:paymentId/commission-breakdown
 * (Registered before GET / so paths are not captured by a generic :param.)
 */
router.get('/:paymentId/commission-breakdown', authorize(['Agent']), async (req, res) => {
  try {
    const ctx = await getAgentContext(req);
    if (!ctx) {
      return res.status(404).json({ success: false, message: 'Agent profile not found' });
    }

    const { paymentId } = req.params;
    const { viewerAgentId, pool, agencyId: viewerAgencyId, userId } = ctx;

    const poolRequest = pool.request();
    poolRequest.input('paymentId', sql.UniqueIdentifier, paymentId);
    poolRequest.input('viewerAgentId', sql.UniqueIdentifier, viewerAgentId);

    const commResult = await poolRequest.query(`
      SELECT
        c.CommissionId,
        c.Amount,
        c.RuleIds,
        c.SplitPartnerAgentId,
        c.SplitPercentage,
        c.IsPrimaryInSplit
      FROM oe.Commissions c
      WHERE c.PaymentId = @paymentId
        AND c.AgentId = @viewerAgentId
        AND c.Status <> N'Deleted'
    `);

    const viewerHasOwnCommission = !!commResult.recordset?.length;

    // Same per-product "who gets paid what" breakdown as Generate commissions preview → Details.
    const preview = await CommissionServiceAdvances.getPaymentBreakdownPreview(paymentId, {
      allowExistingCommissions: true
    });
    if (!preview) {
      return res.status(404).json({
        success: false,
        message: 'Could not load commission breakdown for this payment.'
      });
    }

    const userRoles = getUserRoles(req.user) || [];
    const hasAgencyOwnerRole = userRoles.includes('AgencyOwner');
    const isAgencyOwner =
      hasAgencyOwnerRole ||
      (viewerAgentId && viewerAgencyId
        ? await agencyAdmins.isAgencyAdmin(pool, viewerAgencyId, viewerAgentId)
        : false);
    const selfAndDownlineAgentIds = await getSelfAndDownlineAgentIds(pool, userId);

    // Manager view (downline tab): if viewer is an upline of the selling agent
    // or admin of the selling agent's agency, drop the upline-redaction so they
    // see every agent on the payment — including agents above them in the chain.
    // Agency rows stay gated to the viewer's own agency.
    const requestedDownlineView = String(req.query.perspective || '').toLowerCase() === 'downline';
    const sellingAgentId = preview.sellingAgentId || null;
    const sellingAgencyId = preview.sellingAgentAgencyId || null;
    let unmaskAgents = false;
    let viewerIsManagerOfSelling = false;
    if (sellingAgentId) {
      const viewerIsSelling =
        sellingAgentId && viewerAgentId &&
        sellingAgentId.toString().toLowerCase() === viewerAgentId.toString().toLowerCase();
      const viewerIsUplineOfSelling =
        viewerIsSelling || (await isUplineAncestor(pool, sellingAgentId, viewerAgentId));
      let viewerIsAgencyAdminOfSelling = false;
      if (sellingAgencyId) {
        if (
          viewerAgencyId &&
          sellingAgencyId.toString().toLowerCase() === viewerAgencyId.toString().toLowerCase()
        ) {
          viewerIsAgencyAdminOfSelling = isAgencyOwner;
        } else {
          viewerIsAgencyAdminOfSelling = await agencyAdmins.isAgencyAdmin(
            pool,
            sellingAgencyId,
            viewerAgentId
          );
        }
      }
      viewerIsManagerOfSelling = viewerIsUplineOfSelling || viewerIsAgencyAdminOfSelling;
      if (requestedDownlineView) {
        unmaskAgents = viewerIsManagerOfSelling;
      }
    }

    // Allow access when viewer has their own commission on the payment OR is an
    // upline / agency-admin of the selling agent (manager looking at a downline payout).
    if (!viewerHasOwnCommission && !viewerIsManagerOfSelling) {
      return res.status(404).json({ success: false, message: 'No commission found for this payment' });
    }

    // Match the simulator-side redactor: an agent admin'ing multiple agencies via
    // oe.AgencyAdmins should see breakdown rows for each agency, not just their
    // oe.Agents.AgencyId. Falls back to legacy single-agency check downstream.
    const adminAgencyIds = [];
    try {
      const agencyAdminRecords = await agencyAdmins.getAdministeredAgenciesForAgent(pool, viewerAgentId);
      for (const row of agencyAdminRecords?.recordset || []) {
        if (row?.AgencyId) adminAgencyIds.push(row.AgencyId.toString());
      }
    } catch {
      // best-effort; isAgencyOwner + viewerAgencyId still gates the legacy single agency.
    }

    const data = redactPaymentBreakdownForAgent(
      preview,
      viewerAgencyId,
      isAgencyOwner,
      selfAndDownlineAgentIds,
      viewerAgentId,
      { unmaskAgents, adminAgencyIds }
    );

    if (!data.products || data.products.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No commission detail is available for your account on this payment.'
      });
    }

    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching commission breakdown:', error);
    res.status(500).json({ success: false, message: 'Failed to load commission breakdown' });
  }
});

/**
 * GET /api/me/agent/payments
 * Payments where the authenticated agent has commission rows in oe.Commissions.
 *
 * Query: startDate, endDate, groupId, memberId, search, salesAgentFilter, page, limit
 */
router.get('/', authorize(['Agent']), async (req, res) => {
  try {
    const ctx = await getAgentContext(req);
    if (!ctx) {
      return res.status(404).json({ success: false, message: 'Agent profile not found' });
    }

    const { viewerAgentId, userId, pool, agencyId } = ctx;
    const { startDate, endDate, groupId, memberId, search, salesAgentFilter, perspective, commissionOwnerFilter } = req.query;

    const pageRaw = parseInt(req.query.page, 10);
    const limitRaw = parseInt(req.query.limit, 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 25));
    const offset = (page - 1) * limit;

    const filter = await buildSellingAgentPaymentFilter(req, pool, viewerAgentId, userId, agencyId, salesAgentFilter);
    if (filter.error) {
      return res.status(filter.error).json({ success: false, message: filter.message });
    }

    const ownerFilter = await buildCommissionOwnerFilter(req, pool, viewerAgentId, userId, agencyId, perspective, commissionOwnerFilter);
    if (ownerFilter.error) {
      return res.status(ownerFilter.error).json({ success: false, message: ownerFilter.message });
    }

    const bindListParams = (r) => {
      r.input('viewerAgentId', sql.UniqueIdentifier, viewerAgentId);
      filter.bind(r);
      ownerFilter.bind(r);
      if (startDate) r.input('StartDate', sql.Date, startDate);
      if (endDate) r.input('EndDate', sql.Date, endDate);
      if (groupId) r.input('GroupId', sql.UniqueIdentifier, groupId);
      if (memberId) r.input('MemberId', sql.UniqueIdentifier, memberId);
      if (search) r.input('Search', sql.NVarChar, `%${search}%`);
    };

    const sellingClause = filter.clause;
    // Pass agency column too so agency-recipient rows (AgentId IS NULL,
    // AgencyId NOT NULL) — emitted by tier-paid agencies and primary-overflow —
    // surface in the agency-wide owner scope alongside agent rows.
    const ownerCommClause = ownerFilter.buildInClause('c.AgentId', 'c.AgencyId');
    const ownerPayoutClause = ownerFilter.buildInClause('npd2.RecipientEntityId');

    // Phase 7a: also expose the debit-only sum so the AgentCommissions UI can
    // render a Debits column distinct from net commission (which already
    // factors refund/chargeback rows into the SUM).
    const commAgg = `
      WITH CommAgg AS (
        SELECT
          c.PaymentId,
          c.AgentId AS CommissionOwnerAgentId,
          SUM(c.Amount) AS CommissionAmount,
          SUM(CASE WHEN c.Amount < 0 THEN c.Amount ELSE 0 END) AS DebitAmount
        FROM oe.Commissions c
        WHERE ${ownerCommClause}
          AND c.Status <> N'Deleted'
        GROUP BY c.PaymentId, c.AgentId
      )`;

    const joinsAndWhere = `
      FROM CommAgg ca
      INNER JOIN oe.Payments p ON p.PaymentId = ca.PaymentId
      LEFT JOIN oe.Agents own_a ON ca.CommissionOwnerAgentId = own_a.AgentId
      LEFT JOIN oe.Users own_u ON own_a.UserId = own_u.UserId
      LEFT JOIN oe.Agents sell_a ON p.AgentId = sell_a.AgentId
      LEFT JOIN oe.Users sell_u ON sell_a.UserId = sell_u.UserId
      LEFT JOIN oe.Groups pg ON p.GroupId = pg.GroupId
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Groups ig ON m.GroupId = ig.GroupId
      -- Fallback: payments with no GroupId / EnrollmentId still carry HouseholdId,
      -- which is the household-root MemberId. Resolve member + group from there.
      LEFT JOIN oe.Members hh ON p.HouseholdId = hh.MemberId
      LEFT JOIN oe.Users hh_u ON hh.UserId = hh_u.UserId
      LEFT JOIN oe.Groups hh_g ON hh.GroupId = hh_g.GroupId
      WHERE 1 = 1
        ${sellingClause}
        ${startDate ? 'AND p.PaymentDate >= @StartDate' : ''}
        ${endDate ? 'AND p.PaymentDate < DATEADD(day, 1, @EndDate)' : ''}
        ${groupId ? 'AND COALESCE(pg.GroupId, ig.GroupId, hh_g.GroupId) = @GroupId' : ''}
        ${memberId ? 'AND COALESCE(m.MemberId, hh.MemberId) = @MemberId' : ''}
        ${search ? `AND (
          COALESCE(pg.Name, ig.Name, hh_g.Name, N'') LIKE @Search
          OR ISNULL(u.FirstName + N' ' + u.LastName, N'') LIKE @Search
          OR ISNULL(hh_u.FirstName + N' ' + hh_u.LastName, N'') LIKE @Search
        )` : ''}
    `;

    const countQuery = `
      ${commAgg}
      SELECT COUNT(*) AS Total
      ${joinsAndWhere}
    `;

    const countReq = pool.request();
    bindListParams(countReq);
    const countResult = await countReq.query(countQuery);
    const total = Number(countResult.recordset?.[0]?.Total || 0);

    const dataQuery = `
      ${commAgg}
      SELECT
        p.PaymentId,
        p.PaymentDate,
        p.Amount,
        p.Status,
        p.PaymentMethod,
        p.AgentId AS SellingAgentId,
        ISNULL(sell_u.FirstName + N' ' + sell_u.LastName, N'') AS SellingAgentName,
        CASE WHEN p.AgentId IS NOT NULL AND p.AgentId <> @viewerAgentId THEN 1 ELSE 0 END AS IsUplinePayment,
        COALESCE(pg.GroupId, ig.GroupId, hh_g.GroupId) AS GroupId,
        COALESCE(pg.Name, ig.Name, hh_g.Name) AS GroupName,
        COALESCE(m.MemberId, hh.MemberId) AS MemberId,
        COALESCE(
          NULLIF(LTRIM(RTRIM(ISNULL(u.FirstName, N'') + N' ' + ISNULL(u.LastName, N''))), N''),
          NULLIF(LTRIM(RTRIM(ISNULL(hh_u.FirstName, N'') + N' ' + ISNULL(hh_u.LastName, N''))), N'')
        ) AS MemberName,
        ca.CommissionOwnerAgentId,
        ISNULL(own_u.FirstName + N' ' + own_u.LastName, N'') AS CommissionOwnerName,
        ca.CommissionAmount,
        ca.DebitAmount,
        (
          SELECT TOP 1 ng2.GeneratedDate
          FROM oe.NACHAPaymentDetails npd2
          INNER JOIN oe.NACHAGenerations ng2 ON npd2.NACHAId = ng2.NACHAId
          WHERE npd2.PaymentId = p.PaymentId
            AND npd2.RecipientEntityType = 'Agent'
            AND ${ownerPayoutClause}
            AND ng2.Status = 'Sent'
          ORDER BY ng2.GeneratedDate DESC
        ) AS PayoutDate
      ${joinsAndWhere}
      ORDER BY p.PaymentDate DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;

    const dataReq = pool.request();
    bindListParams(dataReq);
    dataReq.input('offset', sql.Int, offset);
    dataReq.input('limit', sql.Int, limit);
    const result = await dataReq.query(dataQuery);
    const rows = (result.recordset || []).map((r) => ({
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
      commissionOwnerAgentId: r.CommissionOwnerAgentId || null,
      commissionOwnerName: (r.CommissionOwnerName && String(r.CommissionOwnerName).trim()) || null,
      commissionAmount: Number(r.CommissionAmount || 0),
      debitAmount: Number(r.DebitAmount || 0),
      payoutDate: r.PayoutDate || null
    }));

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    res.json({
      success: true,
      data: rows,
      pagination: {
        total,
        page,
        limit,
        totalPages
      }
    });
  } catch (error) {
    console.error('Error fetching agent payments:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch agent payments' });
  }
});

/**
 * GET /api/me/agent/payments/awaiting-commissions
 * Payments tied to the agent's sold groups/enrollments that do NOT yet have
 * commission rows in oe.Commissions for this agent.
 */
router.get('/awaiting-commissions', authorize(['Agent']), async (req, res) => {
  try {
    const ctx = await getAgentContext(req);
    if (!ctx) {
      return res.status(404).json({ success: false, message: 'Agent profile not found' });
    }

    const { viewerAgentId, userId, pool, agencyId } = ctx;
    const { perspective, commissionOwnerFilter } = req.query;

    const pageRaw = parseInt(req.query.page, 10);
    const limitRaw = parseInt(req.query.limit, 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 25));
    const offset = (page - 1) * limit;

    const ownerFilter = await buildCommissionOwnerFilter(req, pool, viewerAgentId, userId, agencyId, perspective, commissionOwnerFilter);
    if (ownerFilter.error) {
      return res.status(ownerFilter.error).json({ success: false, message: ownerFilter.message });
    }

    // p.AgentId is the selling agent — always agent-only (no agency column).
    // c.AgentId / c.AgencyId — pass both so agency-recipient rows surface.
    const ownerSellingClause = ownerFilter.buildInClause('p.AgentId');
    const ownerCommClause = ownerFilter.buildInClause('c.AgentId', 'c.AgencyId');

    const bindParams = (r) => {
      r.input('viewerAgentId', sql.UniqueIdentifier, viewerAgentId);
      ownerFilter.bind(r);
    };

    // "Awaiting commissions" uses the selling agent (p.AgentId) as the commission-
    // owner proxy: a payment is "awaiting" when it's been sold by one of the target
    // agents but no oe.Commissions rows exist yet for that agent on that payment.
    const baseQuery = `
      FROM oe.Payments p
      LEFT JOIN oe.Groups pg ON p.GroupId = pg.GroupId
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      LEFT JOIN oe.Groups ig ON m.GroupId = ig.GroupId
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Agents sell_a ON p.AgentId = sell_a.AgentId
      LEFT JOIN oe.Users sell_u ON sell_a.UserId = sell_u.UserId
      -- Fallback: HouseholdId on the payment is the household-root MemberId.
      LEFT JOIN oe.Members hh ON p.HouseholdId = hh.MemberId
      LEFT JOIN oe.Users hh_u ON hh.UserId = hh_u.UserId
      LEFT JOIN oe.Groups hh_g ON hh.GroupId = hh_g.GroupId
      WHERE ${ownerSellingClause}
        AND p.Status IN ('Completed', 'Paid', 'Succeeded')
        AND NOT EXISTS (
          SELECT 1 FROM oe.Commissions c
          WHERE c.PaymentId = p.PaymentId
            AND ${ownerCommClause}
            AND c.AgentId = p.AgentId
            AND c.Status <> N'Deleted'
        )
    `;

    const countReq = pool.request();
    bindParams(countReq);
    const countResult = await countReq.query(`SELECT COUNT(*) AS Total ${baseQuery}`);
    const total = Number(countResult.recordset?.[0]?.Total || 0);

    const dataReq = pool.request();
    bindParams(dataReq);
    dataReq.input('offset', sql.Int, offset);
    dataReq.input('limit', sql.Int, limit);

    const dataResult = await dataReq.query(`
      SELECT
        p.PaymentId,
        p.PaymentDate,
        p.Amount,
        p.Status,
        p.PaymentMethod,
        p.AgentId AS SellingAgentId,
        ISNULL(sell_u.FirstName + N' ' + sell_u.LastName, N'') AS SellingAgentName,
        p.AgentId AS CommissionOwnerAgentId,
        ISNULL(sell_u.FirstName + N' ' + sell_u.LastName, N'') AS CommissionOwnerName,
        COALESCE(pg.GroupId, ig.GroupId, hh_g.GroupId) AS GroupId,
        COALESCE(pg.Name, ig.Name, hh_g.Name) AS GroupName,
        COALESCE(m.MemberId, hh.MemberId) AS MemberId,
        COALESCE(
          NULLIF(LTRIM(RTRIM(ISNULL(u.FirstName, N'') + N' ' + ISNULL(u.LastName, N''))), N''),
          NULLIF(LTRIM(RTRIM(ISNULL(hh_u.FirstName, N'') + N' ' + ISNULL(hh_u.LastName, N''))), N'')
        ) AS MemberName
      ${baseQuery}
      ORDER BY p.PaymentDate DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    const rows = (dataResult.recordset || []).map((r) => ({
      paymentId: r.PaymentId,
      paymentDate: r.PaymentDate,
      amount: Number(r.Amount || 0),
      status: r.Status,
      paymentMethod: r.PaymentMethod,
      sellingAgentId: r.SellingAgentId || null,
      sellingAgentName: (r.SellingAgentName && String(r.SellingAgentName).trim()) || null,
      commissionOwnerAgentId: r.CommissionOwnerAgentId || null,
      commissionOwnerName: (r.CommissionOwnerName && String(r.CommissionOwnerName).trim()) || null,
      groupId: r.GroupId || null,
      groupName: r.GroupName || null,
      memberId: r.MemberId || null,
      memberName: r.MemberName || null
    }));

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    res.json({
      success: true,
      data: rows,
      pagination: { total, page, limit, totalPages }
    });
  } catch (error) {
    console.error('Error fetching awaiting-commissions payments:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch payments awaiting commissions' });
  }
});

module.exports = router;
