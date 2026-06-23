/**
 * MEMBER PRICING ROUTES - Member role pricing endpoints
 * 
 * Endpoints:
 * - GET /api/me/member/pricing/current - Current member pricing
 */

const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const { PricingEngine } = require('../../../services/pricing');
const { getEffectiveMemberId } = require('../../../middleware/attachMemberHouseholdContext');

/**
 * GET /api/me/member/pricing/current
 * Get current pricing for logged-in member
 */
router.get('/current', authorize(['Member']), async (req, res) => {
  try {
    // Get member ID from authenticated user
    const memberId = getEffectiveMemberId(req);

    console.log('🔍 DEBUG: /api/me/member/pricing/current called for member:', memberId);

    if (!memberId) {
      return res.status(400).json({
        success: false,
        message: 'Member ID not found for authenticated user'
      });
    }

    // Calculate current pricing for this member
    const pricingResult = await PricingEngine.calculatePricing({
      memberId,
      calculationType: 'current'
    });

    console.log('✅ DEBUG: Member current pricing calculation completed successfully');

    res.json({
      success: true,
      data: pricingResult
    });

  } catch (error) {
    console.error('❌ Error in /api/me/member/pricing/current:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching member pricing',
      error: {
        message: error.message,
        code: 'MEMBER_PRICING_ERROR'
      }
    });
  }
});

module.exports = router;