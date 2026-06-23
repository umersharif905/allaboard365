// backend/routes/me/agent/notification-preferences.js
const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const {
  getPreferencesForAgent,
  updatePreferencesForAgent,
  resolveAgentByUserId
} = require('../../../services/agentCommunicationPreferences.service');

router.use(authorize(['Agent']));

async function resolveAgentContext(req) {
  if (!req.user || !req.user.UserId) return null;
  return resolveAgentByUserId(req.user.UserId);
}

/**
 * GET /api/me/agent/notification-preferences
 */
router.get('/', async (req, res) => {
  try {
    const ctx = await resolveAgentContext(req);
    if (!ctx) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }
    const prefs = await getPreferencesForAgent(ctx.agentId);
    return res.json({ success: true, data: prefs });
  } catch (e) {
    console.error('[agent notification-preferences] GET:', e);
    return res.status(500).json({ success: false, message: 'Failed to load notification preferences' });
  }
});

/**
 * PUT /api/me/agent/notification-preferences
 * Body: { enrollmentNotificationsEnabled?, paymentAlertsEnabled?, marketingEnabled? } (booleans)
 */
router.put('/', async (req, res) => {
  try {
    const ctx = await resolveAgentContext(req);
    if (!ctx) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    const { enrollmentNotificationsEnabled, paymentAlertsEnabled, marketingEnabled } = req.body || {};
    const provided = [enrollmentNotificationsEnabled, paymentAlertsEnabled, marketingEnabled]
      .some(v => typeof v === 'boolean');
    if (!provided) {
      return res.status(400).json({
        success: false,
        message: 'Provide at least one boolean preference (enrollmentNotificationsEnabled, paymentAlertsEnabled, marketingEnabled)'
      });
    }

    const updated = await updatePreferencesForAgent(
      ctx.agentId,
      ctx.tenantId,
      { enrollmentNotificationsEnabled, paymentAlertsEnabled, marketingEnabled },
      { source: 'AgentSettings' }
    );

    return res.json({ success: true, data: updated });
  } catch (e) {
    console.error('[agent notification-preferences] PUT:', e);
    return res.status(500).json({ success: false, message: 'Failed to save notification preferences' });
  }
});

module.exports = router;
