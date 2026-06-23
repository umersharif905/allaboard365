const express = require('express');
const router = express.Router();
const { getPool } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const { getAccessibleAgentIdsForUser, buildAgentScopeClause } = require('../../../utils/agentGroupAccess');

/**
 * GET /api/me/agent/group-type-change-requests/pending-action
 *
 * Returns the set of "Approved but not yet applied" type-change requests for
 * groups this agent (or downline) owns. Powers the in-app indicator that
 * tells an agent to open the conversion wizard after their request was
 * approved by a TenantAdmin (or auto-approved).
 *
 * "Not yet applied" === request.CurrentType === group.GroupType — i.e. the
 * wizard's apply step hasn't flipped GroupType yet.
 */
router.get('/pending-action', authorize(['Agent']), async (req, res) => {
  try {
    const pool = await getPool();
    const accessibleAgentIds = await getAccessibleAgentIdsForUser(pool, req.user);
    if (accessibleAgentIds.length === 0) {
      return res.json({ success: true, data: [] });
    }
    const request = pool.request();
    const agentScopeClause = buildAgentScopeClause(request, accessibleAgentIds, 'g.AgentId', 'agScope');
    // "Pending action" = Approved AND not yet applied. AppliedAt IS NULL is
    // the definitive check — set when the wizard's apply step commits. The
    // CurrentType=GroupType comparison stays as a defensive secondary filter
    // (covers any pre-AppliedAt rows that weren't backfilled).
    const result = await request.query(`
      SELECT
        r.RequestId, r.GroupId, r.CurrentType, r.RequestedType, r.Status,
        r.ReviewedAt, r.ReviewNotes, r.CreatedDate,
        g.Name AS GroupName,
        g.GroupType AS CurrentGroupType
      FROM oe.GroupTypeChangeRequests r
      INNER JOIN oe.Groups g ON g.GroupId = r.GroupId
      WHERE r.Status = 'Approved'
        AND r.AppliedAt IS NULL
        AND r.CurrentType = g.GroupType
        AND ${agentScopeClause}
      ORDER BY r.ReviewedAt DESC
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('[agent/group-type-change-requests/pending-action] error:', err);
    res.status(500).json({ success: false, message: 'Server error', code: 'PENDING_ACTION_ERROR' });
  }
});

module.exports = router;
