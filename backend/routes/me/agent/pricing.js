/**
 * AGENT PRICING ROUTES - Agent role pricing endpoints
 * 
 * Endpoints:
 * - GET /api/me/agent/pricing/current/:memberId - Current member pricing (Agent access)
 */

const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const { PricingEngine } = require('../../../services/pricing');

/**
 * GET /api/me/agent/pricing/current/:memberId
 * Get current pricing for a specific member (Agent access)
 */
router.get('/current/:memberId', authorize(['Agent']), async (req, res) => {
  try {
    const { memberId } = req.params;

    console.log('🔍 DEBUG: /api/me/agent/pricing/current called for member:', memberId);

    // Validate memberId format
    if (!memberId || typeof memberId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Valid memberId is required'
      });
    }

    // TODO: Add agent access validation - ensure agent can access this member
    // This would typically check if the member belongs to a group the agent manages
    // For now, we'll proceed with the calculation

    // Calculate current pricing for this member
    const pricingResult = await PricingEngine.calculatePricing({
      memberId,
      calculationType: 'current'
    });

    console.log('✅ DEBUG: Agent current pricing calculation completed successfully');

    res.json({
      success: true,
      data: pricingResult
    });

  } catch (error) {
    console.error('❌ Error in /api/me/agent/pricing/current:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching member pricing',
      error: {
        message: error.message,
        code: 'AGENT_PRICING_ERROR'
      }
    });
  }
});

module.exports = router;
