const express = require('express');
const router = express.Router();
const { getPool } = require('../../config/database');
const sql = require('mssql');
const { authorize } = require('../../middleware/auth');
const requireTenantAccess = require('../../middleware/requireTenantAccess');

/**
 * @route   GET /api/agents/tenant
 * @desc    Get the current agent's tenant information
 * @access  Private (Agent only)
 */
router.get('/', authorize(['Agent']), requireTenantAccess, async (req, res) => {
  try {
    const pool = await getPool();
    const userId = req.user.UserId;

    // Get the tenantId for the current user from oe.Users
    const userResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`
        SELECT TenantId
        FROM oe.Users
        WHERE UserId = @userId
      `);

    if (!userResult.recordset.length || !userResult.recordset[0].TenantId) {
      return res.status(404).json({
        success: false,
        message: 'No tenant assigned to this agent user:' + userId
      });
    }

    const tenantId = userResult.recordset[0].TenantId;

    // Log the userId we are about to query for
    console.log(`[Agent Tenant Route] Fetching tenant for tenantId: ${tenantId}`);

    if(!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'Tenant ID is required'
      });
    }

    const tenantResult = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT 
          t.TenantId, 
          t.Name, 
          t.Status, 
          t.CreatedDate, 
          t.ModifiedDate,
          t.ContactEmail, 
          t.ContactPhone,
          t.PrimaryAddress,
          t.PrimaryCity,
          t.PrimaryState,
          t.PrimaryZip,
          ISNULL(json_value(t.AdvancedSettings, '$.branding.logoUrl'), '') as LogoUrl,
          ISNULL(json_value(t.AdvancedSettings, '$.branding.colors.primary'), '#1f6db0') as PrimaryColor,
          ISNULL(json_value(t.AdvancedSettings, '$.branding.colors.secondary'), '#424242') as SecondaryColor
        FROM oe.Tenants t
        INNER JOIN oe.Users u ON t.TenantId = u.TenantId
        WHERE u.TenantId = @tenantId
      `);

    if (tenantResult.recordset.length === 0) {
      // Log the failure case specifically
      console.warn(`[Agent Tenant Route] No tenant found for userId: ${userId}`);
      return res.status(404).json({
        success: false,
        message: 'Tenant not found for this agent. Please ensure the agent user is correctly assigned to a tenant in the database.'
      });
    }

    // Log the success case
    console.log(`[Agent Tenant Route] Successfully found tenant '${tenantResult.recordset[0].Name}' for userId: ${userId}`);
    res.json({
      success: true,
      data: tenantResult.recordset[0]
    });
  } catch (error) {
    console.error(`[Agent Tenant Route] Server error for userId: ${req.user?.userId}:`, error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching tenant information',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router; 