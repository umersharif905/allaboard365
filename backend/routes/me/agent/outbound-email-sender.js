'use strict';

const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const requireTenantAccess = require('../../../middleware/requireTenantAccess');
const { getAgentSenderContext } = require('../../../utils/agentSenderContext');
const { resolveAgentOutboundEmailEnvelope } = require('../../../utils/agentOutboundEmail');

/**
 * @route   GET /api/me/agent/outbound-email-sender
 * @desc    From / Reply-To preview for agent-originated prospect & proposal email
 * @access  Agent, TenantAdmin
 */
router.get('/', authorize(['Agent', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context is required' });
    }
    const sender = await getAgentSenderContext(req);
    const envelope = await resolveAgentOutboundEmailEnvelope(tenantId, sender);
    return res.json({
      success: true,
      data: envelope,
    });
  } catch (error) {
    console.error('Error loading outbound email sender:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load email sender info',
    });
  }
});

module.exports = router;
