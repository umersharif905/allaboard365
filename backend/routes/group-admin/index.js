// backend/routes/group-admin/index.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { getPool } = require('../../config/database');
const { authorize, requireTenantAccess } = require('../../middleware/auth');
const UserManagementService = require('../../services/shared/user-management.service');

// Import route modules
const groupAgentRoutes = require('./group-agent');
const groupProductsRoutes = require('./group-products');

// Mount route modules
router.use('/', groupAgentRoutes);
router.use('/', groupProductsRoutes);

// GET Group Info - Get group information for the current group admin
router.get('/group-info', authorize(['GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    console.log('🔍 Fetching group info for group admin:', req.user?.UserId);

    const pool = await getPool();
    
    // Get group ID for this admin
    const groupId = await UserManagementService.getGroupIdForUser(req.user.UserId, pool);
    
    if (!groupId) {
      return res.status(404).json({
        success: false,
        message: 'No active group found for this admin'
      });
    }

    // Fetch group details
    const request = pool.request();
    request.input('groupId', sql.UniqueIdentifier, groupId);
    
    const result = await request.query(`
      SELECT 
        g.GroupId,
        g.Name as GroupName,
        g.TenantId,
        t.Name as TenantName,
        g.PrimaryContact,
        g.ContactEmail,
        g.ContactPhone,
        g.Status,
        g.CreatedDate,
        g.ModifiedDate,
        a.FirstName as AgentFirstName,
        a.LastName as AgentLastName
      FROM oe.Groups g
      LEFT JOIN oe.Tenants t ON g.TenantId = t.TenantId
      LEFT JOIN oe.Agents ag ON g.AgentId = ag.AgentId
      LEFT JOIN oe.Users a ON ag.UserId = a.UserId
      WHERE g.GroupId = @groupId
    `);

    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    const groupData = result.recordset[0];

    res.json({
      success: true,
      data: {
        GroupId: groupData.GroupId,
        GroupName: groupData.GroupName,
        TenantId: groupData.TenantId,
        TenantName: groupData.TenantName,
        AgentFirstName: groupData.AgentFirstName,
        AgentLastName: groupData.AgentLastName,
        PrimaryContact: groupData.PrimaryContact,
        ContactEmail: groupData.ContactEmail,
        ContactPhone: groupData.ContactPhone,
        Status: groupData.Status,
        CreatedDate: groupData.CreatedDate,
        ModifiedDate: groupData.ModifiedDate
      }
    });

  } catch (error) {
    console.error('❌ Error fetching group info:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch group information'
    });
  }
});

module.exports = router; 