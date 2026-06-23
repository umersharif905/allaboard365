const express = require('express');
const router = express.Router();
const { getPool } = require('../../../config/database');
const sql = require('mssql');

/**
 * @route   GET /api/me/member/tenant
 * @desc    Get the current member's tenant information
 * @access  Private (Member role)
 */
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const userId = req.user.UserId;

    // Try to resolve the tenant id from the user's record (preferred) and fall back to the member record
    const tenantResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`
        SELECT TOP 1
          COALESCE(u.TenantId, m.TenantId) AS TenantId
        FROM oe.Users u
        LEFT JOIN oe.Members m ON m.UserId = u.UserId
        WHERE u.UserId = @userId
      `);

    if (!tenantResult.recordset.length || !tenantResult.recordset[0].TenantId) {
      return res.status(404).json({
        success: false,
        message: 'No tenant found for the current member.'
      });
    }

    const tenantId = tenantResult.recordset[0].TenantId;

    const tenantInfoResult = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT 
          t.TenantId,
          t.Name,
          ISNULL(json_value(t.AdvancedSettings, '$.branding.logoUrl'), '') AS LogoUrl,
          ISNULL(json_value(t.AdvancedSettings, '$.branding.colors.primary'), '#1f8dbf') AS PrimaryColor,
          ISNULL(json_value(t.AdvancedSettings, '$.features.mobileApp.appStoreUrl'), '') AS AppStoreUrl,
          ISNULL(json_value(t.AdvancedSettings, '$.features.mobileApp.playStoreUrl'), '') AS PlayStoreUrl
        FROM oe.Tenants t
        WHERE t.TenantId = @tenantId
      `);

    if (!tenantInfoResult.recordset.length) {
      return res.status(404).json({
        success: false,
        message: 'Tenant record not found.'
      });
    }

    res.json({
      success: true,
      data: tenantInfoResult.recordset[0]
    });
  } catch (error) {
    console.error('❌ Error fetching member tenant information:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching tenant information',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;

