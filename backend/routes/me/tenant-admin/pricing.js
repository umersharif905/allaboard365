/**
 * TENANT ADMIN PRICING ROUTES - TenantAdmin role pricing endpoints
 * 
 * Endpoints:
 * - GET /api/me/tenant-admin/pricing/current/:memberId - Current member pricing (TenantAdmin access)
 */

const express = require('express');
const router = express.Router();
const { authorize, requireTenantAccess } = require('../../../middleware/auth');
const { PricingEngine } = require('../../../services/pricing');

/**
 * GET /api/me/tenant-admin/pricing/current/:memberId
 * Get current pricing for a specific member (TenantAdmin access)
 */
router.get('/current/:memberId', authorize(['TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { memberId } = req.params;

    console.log('🔍 DEBUG: /api/me/tenant-admin/pricing/current called for member:', memberId);

    // Validate memberId format
    if (!memberId || typeof memberId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Valid memberId is required'
      });
    }

    // TenantAdmin access is validated by requireTenantAccess middleware
    // which ensures the member belongs to the tenant admin's tenant

    // Calculate current pricing for this member
    const pricingResult = await PricingEngine.calculatePricing({
      memberId,
      calculationType: 'current'
    });

    console.log('✅ DEBUG: TenantAdmin current pricing calculation completed successfully');

    res.json({
      success: true,
      data: pricingResult
    });

  } catch (error) {
    console.error('❌ Error in /api/me/tenant-admin/pricing/current:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching member pricing',
      error: {
        message: error.message,
        code: 'TENANT_ADMIN_PRICING_ERROR'
      }
    });
  }
});

module.exports = router;
