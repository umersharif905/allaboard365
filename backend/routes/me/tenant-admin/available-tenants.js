const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authenticate, authorize } = require('../../../middleware/auth');

/**
 * GET /api/me/tenant-admin/available-tenants
 * Get list of tenants that a TenantAdmin can create overrides for
 * For now, returns all tenants (in the future, this could be filtered by subscription relationships)
 */
router.get('/', authenticate, authorize(['TenantAdmin']), async (req, res) => {
  try {
    const pool = await getPool();

    console.log('🏢 Fetching available tenants for TenantAdmin');

    const request = pool.request();

    // Get all active tenants
    // In the future, you might want to filter this to only show tenants that have subscribed to this tenant's products
    const result = await request.query(`
      SELECT 
        TenantId,
        Name,
        Status
      FROM oe.Tenants
      WHERE Status = 'Active'
      ORDER BY Name ASC
    `);

    console.log('✅ Found', result.recordset.length, 'active tenants');

    res.json({
      success: true,
      data: result.recordset
    });

  } catch (error) {
    console.error('❌ Error fetching available tenants:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch available tenants'
    });
  }
});

module.exports = router;

