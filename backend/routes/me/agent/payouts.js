const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const nachaService = require('../../../services/NACHAService');
const { buildSellingAgentPaymentFilter } = require('../../../utils/sellingAgentPaymentFilter');
const { buildCommissionOwnerFilter } = require('../../../utils/commissionOwnerFilter');

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
 * GET /api/me/agent/payouts
 * Sent NACHA payouts for this agent; totals/counts respect salesAgentFilter on underlying payments.
 *
 * Query: startDate, endDate (oe.NACHAGenerations.GeneratedDate), salesAgentFilter, page, limit
 */
router.get('/', authorize(['Agent']), async (req, res) => {
  try {
    const ctx = await getAgentContext(req);
    if (!ctx) {
      return res.status(404).json({ success: false, message: 'Agent profile not found' });
    }

    const { viewerAgentId, userId, pool, agencyId } = ctx;
    const { salesAgentFilter, startDate, endDate, perspective, commissionOwnerFilter } = req.query;

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
    };

    const sellingClause = filter.clause;
    const ownerPayoutClause = ownerFilter.buildInClause('npd.RecipientEntityId');

    // When aggregating across multiple owners, one NACHA file can pay out to several
    // agents; roll up per (NACHAId, RecipientEntityId) so each row has a stable owner.
    const payoutAgg = `
      WITH PayoutAgg AS (
        SELECT
          ng.NACHAId AS NACHAId,
          ng.FileName AS FileName,
          ng.GeneratedDate AS GeneratedDate,
          npd.RecipientEntityId AS RecipientEntityId,
          SUM(COALESCE(npd.Amount, 0)) AS TotalPaidToAgent,
          COUNT(DISTINCT npd.PaymentId) AS PaymentCount
        FROM oe.NACHAPaymentDetails npd
        INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
        INNER JOIN oe.Payments p ON npd.PaymentId = p.PaymentId
        WHERE npd.RecipientEntityType = N'Agent'
          AND ${ownerPayoutClause}
          AND ng.Status = N'Sent'
          ${sellingClause}
          ${startDate ? 'AND ng.GeneratedDate >= @StartDate' : ''}
          ${endDate ? 'AND ng.GeneratedDate < DATEADD(day, 1, @EndDate)' : ''}
        GROUP BY ng.NACHAId, ng.FileName, ng.GeneratedDate, npd.RecipientEntityId
      )`;

    const fromPayoutAgg = `
      FROM PayoutAgg pa
      LEFT JOIN oe.Agents own_a ON pa.RecipientEntityId = own_a.AgentId
      LEFT JOIN oe.Users own_u ON own_a.UserId = own_u.UserId
    `;

    const countQuery = `
      ${payoutAgg}
      SELECT COUNT(*) AS Total
      ${fromPayoutAgg}
    `;

    const countReq = pool.request();
    bindListParams(countReq);
    const countResult = await countReq.query(countQuery);
    const total = Number(countResult.recordset?.[0]?.Total || 0);

    const dataQuery = `
      ${payoutAgg}
      SELECT
        pa.NACHAId AS nachaId,
        pa.FileName AS fileName,
        pa.GeneratedDate AS generatedDate,
        pa.RecipientEntityId AS commissionOwnerAgentId,
        ISNULL(own_u.FirstName + N' ' + own_u.LastName, N'') AS commissionOwnerName,
        pa.TotalPaidToAgent AS totalPaidToAgent,
        pa.PaymentCount AS paymentCount
      ${fromPayoutAgg}
      ORDER BY pa.GeneratedDate DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;

    const dataReq = pool.request();
    bindListParams(dataReq);
    dataReq.input('offset', sql.Int, offset);
    dataReq.input('limit', sql.Int, limit);
    const result = await dataReq.query(dataQuery);

    const rows = (result.recordset || []).map((r) => ({
      nachaId: r.nachaId,
      fileName: r.fileName || null,
      generatedDate: r.generatedDate,
      commissionOwnerAgentId: r.commissionOwnerAgentId || null,
      commissionOwnerName: (r.commissionOwnerName && String(r.commissionOwnerName).trim()) || null,
      totalPaidToAgent: Number(r.totalPaidToAgent || 0),
      paymentCount: Number(r.paymentCount || 0)
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
    console.error('Error fetching agent payouts:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch agent payouts' });
  }
});

/**
 * GET /api/me/agent/payouts/:nachaId/included-payments
 * Payments in this NACHA for this agent (same shape as GET /payments).
 */
router.get('/:nachaId/included-payments', authorize(['Agent']), async (req, res) => {
  try {
    const ctx = await getAgentContext(req);
    if (!ctx) {
      return res.status(404).json({ success: false, message: 'Agent profile not found' });
    }

    const { nachaId } = req.params;
    const { viewerAgentId, userId, pool, agencyId } = ctx;
    const { startDate, endDate, groupId, memberId, search, salesAgentFilter, perspective, commissionOwnerFilter, commissionOwnerAgentId } = req.query;

    const filter = await buildSellingAgentPaymentFilter(req, pool, viewerAgentId, userId, agencyId, salesAgentFilter);
    if (filter.error) {
      return res.status(filter.error).json({ success: false, message: filter.message });
    }

    // If a specific owner agent was selected in the payout list (so drilling into
    // one agent's payout row), pin the included-payments to that agent id.
    const effectiveOwnerFilter = commissionOwnerAgentId || commissionOwnerFilter;
    const ownerFilter = await buildCommissionOwnerFilter(req, pool, viewerAgentId, userId, agencyId, perspective, effectiveOwnerFilter);
    if (ownerFilter.error) {
      return res.status(ownerFilter.error).json({ success: false, message: ownerFilter.message });
    }

    const request = pool.request();
    request.input('viewerAgentId', sql.UniqueIdentifier, viewerAgentId);
    request.input('nachaId', sql.UniqueIdentifier, nachaId);
    filter.bind(request);
    ownerFilter.bind(request);

    if (startDate) request.input('StartDate', sql.Date, startDate);
    if (endDate) request.input('EndDate', sql.Date, endDate);
    if (groupId) request.input('GroupId', sql.UniqueIdentifier, groupId);
    if (memberId) request.input('MemberId', sql.UniqueIdentifier, memberId);
    if (search) request.input('Search', sql.NVarChar, `%${search}%`);

    const sellingClause = filter.clause;
    const ownerCommClause = ownerFilter.buildInClause('c.AgentId', 'c.AgencyId');
    const ownerNachaClause = ownerFilter.buildInClause('npd.RecipientEntityId');

    const query = `
      WITH CommAgg AS (
        SELECT
          c.PaymentId,
          c.AgentId AS CommissionOwnerAgentId,
          SUM(c.Amount) AS CommissionAmount
        FROM oe.Commissions c
        WHERE ${ownerCommClause}
          AND c.Status <> N'Deleted'
        GROUP BY c.PaymentId, c.AgentId
      )
      SELECT TOP 500
        p.PaymentId,
        p.PaymentDate,
        p.Amount,
        p.Status,
        p.PaymentMethod,
        p.AgentId AS SellingAgentId,
        ISNULL(sell_u.FirstName + N' ' + sell_u.LastName, N'') AS SellingAgentName,
        CASE WHEN p.AgentId IS NOT NULL AND p.AgentId <> @viewerAgentId THEN 1 ELSE 0 END AS IsUplinePayment,
        COALESCE(pg.GroupId, ig.GroupId, hh_g.GroupId, hhs_g.GroupId) AS GroupId,
        COALESCE(pg.Name, ig.Name, hh_g.Name, hhs_g.Name) AS GroupName,
        COALESCE(m.MemberId, hh.MemberId, hhs.HhScopeMemberId) AS MemberId,
        COALESCE(
          NULLIF(LTRIM(RTRIM(ISNULL(u.FirstName, N'') + N' ' + ISNULL(u.LastName, N''))), N''),
          NULLIF(LTRIM(RTRIM(ISNULL(hh_u.FirstName, N'') + N' ' + ISNULL(hh_u.LastName, N''))), N''),
          hhs.HhScopeMemberName
        ) AS MemberName,
        ca.CommissionOwnerAgentId,
        ISNULL(own_u.FirstName + N' ' + own_u.LastName, N'') AS CommissionOwnerName,
        ca.CommissionAmount,
        npd.Amount AS PayoutLineAmount
      FROM oe.NACHAPaymentDetails npd
      INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId AND ng.NACHAId = @nachaId
      INNER JOIN oe.Payments p ON npd.PaymentId = p.PaymentId
      INNER JOIN CommAgg ca
        ON ca.PaymentId = p.PaymentId
       AND ca.CommissionOwnerAgentId = npd.RecipientEntityId
      LEFT JOIN oe.Agents own_a ON ca.CommissionOwnerAgentId = own_a.AgentId
      LEFT JOIN oe.Users own_u ON own_a.UserId = own_u.UserId
      LEFT JOIN oe.Agents sell_a ON p.AgentId = sell_a.AgentId
      LEFT JOIN oe.Users sell_u ON sell_a.UserId = sell_u.UserId
      LEFT JOIN oe.Groups pg ON p.GroupId = pg.GroupId
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Groups ig ON m.GroupId = ig.GroupId
      -- Fallback A: Payments.HouseholdId may equal subscriber MemberId (legacy).
      LEFT JOIN oe.Members hh ON p.HouseholdId = hh.MemberId
      LEFT JOIN oe.Users hh_u ON hh.UserId = hh_u.UserId
      LEFT JOIN oe.Groups hh_g ON hh.GroupId = hh_g.GroupId
      -- Fallback B: Payments.HouseholdId is oe.Members.HouseholdId (household key); pick a display member.
      OUTER APPLY (
        SELECT TOP 1
          hm.MemberId AS HhScopeMemberId,
          hm.GroupId AS HhScopeGroupId,
          NULLIF(LTRIM(RTRIM(ISNULL(hu.FirstName, N'') + N' ' + ISNULL(hu.LastName, N''))), N'') AS HhScopeMemberName
        FROM oe.Members hm
        INNER JOIN oe.Users hu ON hm.UserId = hu.UserId
        WHERE p.HouseholdId IS NOT NULL
          AND hm.HouseholdId = p.HouseholdId
          AND hm.Status IN (N'Active', N'Pending')
        ORDER BY
          CASE hm.RelationshipType
            WHEN N'S' THEN 0
            WHEN N'P' THEN 1
            ELSE 2
          END,
          ISNULL(hm.MemberSequence, 2147483647),
          hm.CreatedDate
      ) hhs
      LEFT JOIN oe.Groups hhs_g ON hhs.HhScopeGroupId = hhs_g.GroupId
      WHERE npd.RecipientEntityType = N'Agent'
        AND ${ownerNachaClause}
        AND npd.NACHAId = @nachaId
        AND ng.Status = N'Sent'
        ${sellingClause}
        ${startDate ? 'AND p.PaymentDate >= @StartDate' : ''}
        ${endDate ? 'AND p.PaymentDate < DATEADD(day, 1, @EndDate)' : ''}
        ${groupId ? 'AND COALESCE(pg.GroupId, ig.GroupId, hh_g.GroupId, hhs_g.GroupId) = @GroupId' : ''}
        ${memberId ? 'AND COALESCE(m.MemberId, hh.MemberId, hhs.HhScopeMemberId) = @MemberId' : ''}
        ${search ? `AND (
          COALESCE(pg.Name, ig.Name, hh_g.Name, hhs_g.Name, N'') LIKE @Search
          OR ISNULL(u.FirstName + N' ' + u.LastName, N'') LIKE @Search
          OR ISNULL(hh_u.FirstName + N' ' + hh_u.LastName, N'') LIKE @Search
          OR ISNULL(hhs.HhScopeMemberName, N'') LIKE @Search
        )` : ''}
      ORDER BY p.PaymentDate DESC
    `;

    const result = await request.query(query);
    const rows = (result.recordset || []).map((r) => {
      const aggComm = Number(r.CommissionAmount || 0);
      const lineAmt = Number(r.PayoutLineAmount || 0);
      const commissionAmount =
        Math.abs(aggComm) < 0.0005 && Math.abs(lineAmt) > 0.0005 ? lineAmt : aggComm;

      return {
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
        commissionAmount,
        payoutLineAmount: lineAmt
      };
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching included payments:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch included payments' });
  }
});

/**
 * GET /api/me/agent/payouts/:nachaId/export-details
 * Return export details for this agent for a specific NACHA file.
 */
router.get('/:nachaId/export-details', authorize(['Agent']), async (req, res) => {
  try {
    const { nachaId } = req.params;
    const ctx = await getAgentContext(req);
    if (!ctx) {
      return res.status(404).json({ success: false, message: 'Agent profile not found' });
    }

    const details = await nachaService.getExportDetails('Agent', ctx.viewerAgentId, null, null, nachaId);
    res.json({ success: true, data: details });
  } catch (error) {
    console.error('Error fetching agent payout export details:', error);
    res.status(500).json({ success: false, message: 'Failed to get NACHA details' });
  }
});

module.exports = router;
