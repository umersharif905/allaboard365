// backend/routes/me/tenant-admin/agencies.js
// Tenant-scoped agencies and agents for dropdowns (respects x-current-tenant-id / tenant switching)
const express = require('express');
const router = express.Router();
const { getPool } = require('../../../config/database');
const sql = require('mssql');
const { authorize } = require('../../../middleware/auth');

/**
 * @route   GET /api/me/tenant-admin/agencies
 * @desc    Get all agencies for the current tenant (respects tenant switch)
 * @access  TenantAdmin, SysAdmin
 */
router.get('/', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    // Use req.tenantId set by requireTenantAccess - respects x-current-tenant-id
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        message: 'Tenant context is required',
      });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('TenantId', sql.UniqueIdentifier, tenantId);

    const result = await request.query(`
      SELECT 
        a.AgencyId,
        a.AgencyCode,
        a.AgencyName,
        a.AgencyType,
        a.Status,
        a.ContractDate,
        a.TerminationDate,
        a.CreatedDate,
        a.ModifiedDate,
        t.Name as TenantName
      FROM oe.Agencies a
      LEFT JOIN oe.Tenants t ON a.TenantId = t.TenantId
      WHERE a.TenantId = @TenantId AND a.Status = 'Active'
      ORDER BY a.AgencyName
    `);

    res.json({
      success: true,
      data: result.recordset,
    });
  } catch (error) {
    console.error('❌ Error fetching tenant-admin agencies:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch agencies',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * @route   GET /api/me/tenant-admin/agencies/agents
 * @desc    Get agents for the current tenant (for dropdowns; respects tenant switch)
 * @query   search - optional search string; agencyId - optional filter by agency
 * @access  TenantAdmin, SysAdmin
 */
router.get('/agents', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        message: 'Tenant context is required',
      });
    }

    const { search, agencyId } = req.query;
    const pool = await getPool();
    const request = pool.request();
    request.input('TenantId', sql.UniqueIdentifier, tenantId);

    let whereClause = 'r.Name = \'Agent\' AND u.Status = \'Active\' AND a.Status = \'Active\' AND u.TenantId = @TenantId';
    if (search) {
      request.input('Search', sql.NVarChar(100), `%${search}%`);
      whereClause += ' AND (u.FirstName LIKE @Search OR u.LastName LIKE @Search OR u.Email LIKE @Search)';
    }
    if (agencyId) {
      request.input('AgencyId', sql.UniqueIdentifier, agencyId);
      whereClause += ' AND a.AgencyId = @AgencyId';
    }

    const result = await request.query(`
      SELECT DISTINCT
        u.UserId,
        u.FirstName,
        u.LastName,
        u.Email,
        u.Status,
        u.TenantId,
        t.Name as TenantName,
        a.AgentId,
        a.AgencyId,
        ag.AgencyName,
        a.NPN,
        a.CommissionRole,
        a.Status as AgentStatus
      FROM oe.Users u
      INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId
      INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
      LEFT JOIN oe.Tenants t ON u.TenantId = t.TenantId
      LEFT JOIN oe.Agents a ON u.UserId = a.UserId
      LEFT JOIN oe.Agencies ag ON a.AgencyId = ag.AgencyId
      WHERE ${whereClause}
      ORDER BY u.LastName, u.FirstName
    `);

    res.json({
      success: true,
      data: result.recordset,
    });
  } catch (error) {
    console.error('❌ Error fetching tenant-admin agents:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch agents',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

module.exports = router;
