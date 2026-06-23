/**
 * GET /api/me/agent/assignable-agents — agents an Agent may assign (members / groups).
 * Agency-wide vs downline lists are decided in getAssignableAgentsForViewer (oe.AgencyAdmins), not JWT AgencyOwner.
 */
const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const { getAssignableAgentsForViewer } = require('../../../utils/agentAssignable');

router.get('/', authorize(['Agent', 'AgencyOwner']), async (req, res) => {
  try {
    const userId = req.user?.UserId || req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const { forGroupId, forMemberId } = req.query;
    const pool = await getPool();
    const result = await getAssignableAgentsForViewer(pool, userId, {
      forGroupId: forGroupId && String(forGroupId).trim() ? String(forGroupId).trim() : undefined,
      forMemberId: forMemberId && String(forMemberId).trim() ? String(forMemberId).trim() : undefined
    });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('assignable-agents error:', err);
    res.status(500).json({ success: false, message: 'Failed to load assignable agents' });
  }
});

module.exports = router;
