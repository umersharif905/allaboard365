/**
 * PRICING ROUTES - Admin-scoped pricing endpoints
 * 
 * Endpoints:
 * - POST /api/pricing/calculate - Unified pricing calculation
 * - GET /api/pricing/current/:memberId - Current member pricing (Admin access)
 */

const express = require('express');
const router = express.Router();
const { authorize, requireTenantAccess } = require('../middleware/auth');
const { PricingEngine } = require('../services/pricing');

/**
 * POST /api/pricing/calculate
 * Unified pricing calculation endpoint
 * Used by: EnrollmentWizard, Admin tools, Simulations
 */
router.post('/calculate', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'Member']), async (req, res) => {
  try {
    const {
      memberId,
      calculationType,
      productSelections,
      memberCriteria,
      groupId,
      simulationContext,
      effectiveDate
    } = req.body;

    console.log('🔍 DEBUG: /api/pricing/calculate called with:', {
      calculationType,
      memberId: memberId ? 'provided' : 'not provided',
      productSelectionsCount: productSelections?.length || 0,
      groupId: groupId ? 'provided' : 'not provided',
      productSelections: productSelections?.map(ps => ({
        productId: ps.productId?.substring(0, 8),
        hasConfigValues: !!ps.configValues,
        configValues: ps.configValues
      })),
      memberCriteria
    });

    // Validate required parameters
    if (!calculationType || !['enrollment', 'current', 'simulation'].includes(calculationType)) {
      return res.status(400).json({
        success: false,
        message: 'calculationType is required and must be one of: enrollment, current, simulation'
      });
    }

    // For current calculations, memberId is required
    if (calculationType === 'current' && !memberId) {
      return res.status(400).json({
        success: false,
        message: 'memberId is required for current calculations'
      });
    }

    // For enrollment and simulation, memberCriteria is required
    if (['enrollment', 'simulation'].includes(calculationType) && !memberCriteria) {
      return res.status(400).json({
        success: false,
        message: 'memberCriteria is required for enrollment and simulation calculations'
      });
    }

    // For enrollment calculations, productSelections is required
    if (calculationType === 'enrollment' && (!productSelections || !Array.isArray(productSelections))) {
      return res.status(400).json({
        success: false,
        message: 'productSelections array is required for enrollment calculations'
      });
    }

    // For simulation calculations, simulationContext is required
    if (calculationType === 'simulation' && !simulationContext) {
      return res.status(400).json({
        success: false,
        message: 'simulationContext is required for simulation calculations'
      });
    }

    // Calculate pricing using unified engine
    const pricingResult = await PricingEngine.calculatePricing({
      memberId,
      calculationType,
      productSelections,
      memberCriteria,
      groupId,
      simulationContext,
      effectiveDate: effectiveDate || null // Pass effective date to select correct pricing tiers
    });

    console.log('✅ DEBUG: Pricing calculation completed successfully');

    res.json({
      success: true,
      data: pricingResult
    });

  } catch (error) {
    console.error('❌ Error in /api/pricing/calculate:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while calculating pricing',
      error: {
        message: error.message,
        code: 'PRICING_CALCULATION_ERROR'
      }
    });
  }
});

/**
 * GET /api/pricing/current/:memberId
 * Get current pricing for existing member (Admin access)
 */
router.get('/current/:memberId', authorize(['SysAdmin', 'TenantAdmin', 'Agent']), requireTenantAccess, async (req, res) => {
  try {
    const { memberId } = req.params;

    console.log('🔍 DEBUG: /api/pricing/current called for member:', memberId);

    // Validate memberId format
    if (!memberId || typeof memberId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Valid memberId is required'
      });
    }

    // Calculate current pricing
    const pricingResult = await PricingEngine.calculatePricing({
      memberId,
      calculationType: 'current'
    });

    console.log('✅ DEBUG: Current pricing calculation completed successfully');

    res.json({
      success: true,
      data: pricingResult
    });

  } catch (error) {
    console.error('❌ Error in /api/pricing/current:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching current pricing',
      error: {
        message: error.message,
        code: 'CURRENT_PRICING_ERROR'
      }
    });
  }
});

module.exports = router;
