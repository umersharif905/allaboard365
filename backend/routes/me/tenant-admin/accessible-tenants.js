const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authenticate, authorize } = require('../../../middleware/auth');

/**
 * GET /api/me/tenant-admin/accessible-tenants
 * Get list of tenants that a TenantAdmin can switch to
 * Returns only the tenants the user has access to (based on TenantId and AdditionalTenants)
 */
router.get('/', authenticate, authorize(['TenantAdmin']), async (req, res) => {
  try {
    const pool = await getPool();

    if (!req.user || !req.user.TenantId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication error: User or tenant information is missing.'
      });
    }

    console.log('🏢 Fetching accessible tenants for TenantAdmin');

    // Fetch user data from database to ensure we have AdditionalTenants
    const userRequest = pool.request();
    userRequest.input('userId', sql.UniqueIdentifier, req.user.UserId);
    const userResult = await userRequest.query(`
      SELECT TenantId, AdditionalTenants
      FROM oe.Users
      WHERE UserId = @userId
    `);

    if (userResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const userData = userResult.recordset[0];
    
    // Get accessible tenant IDs
    const accessibleTenantIds = [userData.TenantId];
    
    // Parse AdditionalTenants if present
    if (userData.AdditionalTenants) {
      let additionalTenants = [];
      try {
        // AdditionalTenants might be a JSON string or already an array
        if (typeof userData.AdditionalTenants === 'string') {
          additionalTenants = JSON.parse(userData.AdditionalTenants);
        } else if (Array.isArray(userData.AdditionalTenants)) {
          additionalTenants = userData.AdditionalTenants;
        }
        
        // Filter out invalid tenant IDs (like '00000000-0000-0000-0000-000000000000')
        additionalTenants = additionalTenants.filter(
          id => id && id !== '00000000-0000-0000-0000-000000000000'
        );
        
        accessibleTenantIds.push(...additionalTenants);
      } catch (parseError) {
        console.warn('⚠️ Error parsing AdditionalTenants:', parseError);
      }
    }

    // Remove duplicates
    const uniqueTenantIds = [...new Set(accessibleTenantIds)];

    if (uniqueTenantIds.length === 0) {
      return res.json({
        success: true,
        data: []
      });
    }

    // Build query with IN clause for all accessible tenant IDs
    const request = pool.request();
    const tenantIdPlaceholders = uniqueTenantIds.map((_, index) => {
      const paramName = `tenantId${index}`;
      request.input(paramName, sql.UniqueIdentifier, uniqueTenantIds[index]);
      return `@${paramName}`;
    }).join(', ');

    const query = `
      SELECT 
        TenantId,
        Name,
        Status
      FROM oe.Tenants
      WHERE TenantId IN (${tenantIdPlaceholders})
        AND Status = 'Active'
      ORDER BY Name ASC
    `;

    const result = await request.query(query);

    console.log(`✅ Found ${result.recordset.length} accessible tenants for TenantAdmin`);

    res.json({
      success: true,
      data: result.recordset
    });

  } catch (error) {
    console.error('❌ Error fetching accessible tenants:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch accessible tenants',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;

