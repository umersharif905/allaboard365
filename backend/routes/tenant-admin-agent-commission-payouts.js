const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { authorize } = require('../middleware/auth');
const { getPool } = require('../config/database');
const CommissionCalculatorService = require('../services/CommissionCalculatorService');

/**
 * Verify that the given agentId belongs to the authenticated TenantAdmin's tenant.
 * Returns { agentId, tenantId } or null if not found / not in tenant.
 */
async function resolveAgentForTenant(req, agentId) {
  const pool = await getPool();
  const tenantId = req.user?.TenantId || req.user?.tenantId;
  if (!tenantId || !agentId) return null;

  const r = pool.request();
  r.input('AgentId', sql.UniqueIdentifier, agentId);
  r.input('TenantId', sql.UniqueIdentifier, tenantId);
  const result = await r.query(`
    SELECT AgentId, TenantId
    FROM oe.Agents
    WHERE AgentId = @AgentId
      AND TenantId = @TenantId
      AND Status = 'Active'
  `);
  return result.recordset?.[0] || null;
}

/**
 * GET /api/tenant-admin/agents/:agentId/commission-payouts
 * NACHA-grouped payout list for a specific agent (TenantAdmin scoped).
 * Adapted from /api/me/agent/payouts.
 */
router.get('/:agentId/commission-payouts', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { agentId } = req.params;
    const agent = await resolveAgentForTenant(req, agentId);
    if (!agent) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    const pool = await getPool();
    const { startDate, endDate } = req.query;
    const pageRaw = parseInt(req.query.page, 10);
    const limitRaw = parseInt(req.query.limit, 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 25));
    const offset = (page - 1) * limit;

    const payoutAgg = `
      WITH PayoutAgg AS (
        SELECT
          ng.NACHAId          AS NACHAId,
          ng.FileName         AS FileName,
          ng.GeneratedDate    AS GeneratedDate,
          SUM(COALESCE(npd.Amount, 0)) AS TotalPaidToAgent,
          COUNT(DISTINCT npd.PaymentId) AS PaymentCount
        FROM oe.NACHAPaymentDetails npd
        INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
        INNER JOIN oe.Payments p ON npd.PaymentId = p.PaymentId
        WHERE npd.RecipientEntityType = N'Agent'
          AND npd.RecipientEntityId = @AgentId
          AND ng.Status = N'Sent'
          ${startDate ? 'AND ng.GeneratedDate >= @StartDate' : ''}
          ${endDate ? 'AND ng.GeneratedDate < DATEADD(day, 1, @EndDate)' : ''}
        GROUP BY ng.NACHAId, ng.FileName, ng.GeneratedDate
      )`;

    const bindParams = (r) => {
      r.input('AgentId', sql.UniqueIdentifier, agentId);
      if (startDate) r.input('StartDate', sql.Date, startDate);
      if (endDate) r.input('EndDate', sql.Date, endDate);
    };

    const countReq = pool.request();
    bindParams(countReq);
    const countResult = await countReq.query(`${payoutAgg} SELECT COUNT(*) AS Total FROM PayoutAgg`);
    const total = Number(countResult.recordset?.[0]?.Total || 0);

    const dataReq = pool.request();
    bindParams(dataReq);
    dataReq.input('offset', sql.Int, offset);
    dataReq.input('limit', sql.Int, limit);
    const dataResult = await dataReq.query(`
      ${payoutAgg}
      SELECT
        pa.NACHAId        AS nachaId,
        pa.FileName       AS fileName,
        pa.GeneratedDate  AS generatedDate,
        pa.TotalPaidToAgent AS totalPaidToAgent,
        pa.PaymentCount   AS paymentCount
      FROM PayoutAgg pa
      ORDER BY pa.GeneratedDate DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    const rows = (dataResult.recordset || []).map((r) => ({
      nachaId: r.nachaId,
      fileName: r.fileName || null,
      generatedDate: r.generatedDate,
      totalPaidToAgent: Number(r.totalPaidToAgent || 0),
      paymentCount: Number(r.paymentCount || 0)
    }));

    res.json({
      success: true,
      data: rows,
      pagination: { total, page, limit, totalPages: total === 0 ? 0 : Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('Error fetching agent commission payouts:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch agent commission payouts' });
  }
});

/**
 * GET /api/tenant-admin/agents/:agentId/commission-payouts/:nachaId/payments
 * Payments included in a specific NACHA payout for the given agent (TenantAdmin scoped).
 * Adapted from /api/me/agent/payouts/:nachaId/included-payments.
 * Includes commissionTierLevelSnapshot from oe.Commissions.
 */
router.get('/:agentId/commission-payouts/:nachaId/payments', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { agentId, nachaId } = req.params;
    const agent = await resolveAgentForTenant(req, agentId);
    if (!agent) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('AgentId', sql.UniqueIdentifier, agentId);
    request.input('NACHAId', sql.UniqueIdentifier, nachaId);

    const query = `
      WITH CommAgg AS (
        SELECT
          c.PaymentId,
          SUM(c.Amount)                                AS CommissionAmount,
          MAX(c.CommissionTierLevel_Snapshot)          AS CommissionTierLevelSnapshot,
          MAX(c.CommissionTierLevel_Snapshot_Label)    AS CommissionTierLevelSnapshotLabel
        FROM oe.Commissions c
        WHERE c.AgentId = @AgentId
          AND c.Status <> N'Deleted'
        GROUP BY c.PaymentId
      )
      SELECT TOP 500
        p.PaymentId,
        p.PaymentDate,
        p.Amount,
        p.Status,
        p.PaymentMethod,
        ISNULL(sell_u.FirstName + N' ' + sell_u.LastName, N'') AS SellingAgentName,
        COALESCE(pg.GroupId, ig.GroupId, hh_g.GroupId, hhs_g.GroupId) AS GroupId,
        COALESCE(pg.Name, ig.Name, hh_g.Name, hhs_g.Name) AS GroupName,
        COALESCE(m.MemberId, hh.MemberId, hhs.HhScopeMemberId) AS MemberId,
        COALESCE(
          NULLIF(LTRIM(RTRIM(ISNULL(u.FirstName, N'') + N' ' + ISNULL(u.LastName, N''))), N''),
          NULLIF(LTRIM(RTRIM(ISNULL(hh_u.FirstName, N'') + N' ' + ISNULL(hh_u.LastName, N''))), N''),
          hhs.HhScopeMemberName
        ) AS MemberName,
        ca.CommissionAmount,
        npd.Amount AS PayoutLineAmount,
        ca.CommissionTierLevelSnapshot,
        ca.CommissionTierLevelSnapshotLabel
      FROM oe.NACHAPaymentDetails npd
      INNER JOIN oe.NACHAGenerations ng
        ON npd.NACHAId = ng.NACHAId AND ng.NACHAId = @NACHAId
      INNER JOIN oe.Payments p ON npd.PaymentId = p.PaymentId
      INNER JOIN CommAgg ca   ON ca.PaymentId = p.PaymentId
      LEFT JOIN oe.Agents sell_a ON p.AgentId = sell_a.AgentId
      LEFT JOIN oe.Users sell_u  ON sell_a.UserId = sell_u.UserId
      LEFT JOIN oe.Groups pg     ON p.GroupId = pg.GroupId
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m     ON e.MemberId = m.MemberId
      LEFT JOIN oe.Users u       ON m.UserId = u.UserId
      LEFT JOIN oe.Groups ig     ON m.GroupId = ig.GroupId
      LEFT JOIN oe.Members hh ON p.HouseholdId = hh.MemberId
      LEFT JOIN oe.Users hh_u ON hh.UserId = hh_u.UserId
      LEFT JOIN oe.Groups hh_g ON hh.GroupId = hh_g.GroupId
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
        AND npd.RecipientEntityId   = @AgentId
        AND npd.NACHAId             = @NACHAId
        AND ng.Status               = N'Sent'
      ORDER BY p.PaymentDate DESC
    `;

    const result = await request.query(query);
    const rows = (result.recordset || []).map((r) => {
      const aggComm = Number(r.CommissionAmount || 0);
      const lineAmt = Number(r.PayoutLineAmount || 0);
      // When oe.Commissions net to $0 (adjustments/clawbacks) but NACHA still allocates this line, show the payout slice.
      const commissionAmount =
        Math.abs(aggComm) < 0.0005 && Math.abs(lineAmt) > 0.0005 ? lineAmt : aggComm;

      return {
        paymentId: r.PaymentId,
        paymentDate: r.PaymentDate,
        amount: Number(r.Amount || 0),
        status: r.Status,
        paymentMethod: r.PaymentMethod || null,
        sellingAgentName: (r.SellingAgentName && String(r.SellingAgentName).trim()) || null,
        groupId: r.GroupId || null,
        groupName: r.GroupName || null,
        memberId: r.MemberId || null,
        memberName: (r.MemberName && String(r.MemberName).trim()) || null,
        commissionAmount,
        payoutLineAmount: lineAmt,
        commissionTierLevelSnapshot: r.CommissionTierLevelSnapshot != null ? Number(r.CommissionTierLevelSnapshot) : null,
        commissionTierLevelSnapshotLabel:
          (r.CommissionTierLevelSnapshotLabel && String(r.CommissionTierLevelSnapshotLabel).trim()) || null
      };
    });

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Error fetching payout payments:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch payout payments' });
  }
});

/**
 * GET /api/tenant-admin/agents/:agentId/effective-commission-group
 * Resolves the effective commission group for an agent by walking upline → agency chain.
 * Returns { commissionGroupId, name, source: 'direct'|'inherited' } or null if none found.
 */
router.get('/:agentId/effective-commission-group', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { agentId } = req.params;
    const agent = await resolveAgentForTenant(req, agentId);
    if (!agent) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    const tenantId = req.user?.TenantId || req.user?.tenantId;

    // Check if agent has a directly assigned commission group
    const pool = await getPool();
    const directReq = pool.request();
    directReq.input('AgentId', sql.UniqueIdentifier, agentId);
    const directResult = await directReq.query(`
      SELECT CommissionGroupId FROM oe.Agents WHERE AgentId = @AgentId
    `);
    const hasDirect = !!directResult.recordset?.[0]?.CommissionGroupId;

    let groupId = null;
    try {
      const calc = new CommissionCalculatorService();
      groupId = await calc.resolveCommissionGroupId(agentId, tenantId);
    } catch {
      return res.json({ success: true, data: null });
    }

    // Get group name
    const nameReq = pool.request();
    nameReq.input('GroupId', sql.UniqueIdentifier, groupId);
    const nameResult = await nameReq.query(`
      SELECT Name FROM oe.CommissionGroups WHERE CommissionGroupId = @GroupId
    `);
    const name = nameResult.recordset?.[0]?.Name || null;

    res.json({
      success: true,
      data: {
        commissionGroupId: groupId,
        name,
        source: hasDirect ? 'direct' : 'inherited'
      }
    });
  } catch (err) {
    console.error('Error fetching effective commission group:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch effective commission group' });
  }
});

module.exports = router;
