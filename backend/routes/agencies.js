// backend/routes/agencies.js - COMPLETE FIXED VERSION
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { getPool } = require('../config/database');
const { getUserRoles } = require('../middleware/auth');

// Authorization middleware - EXACT pattern from other working routes
const authorize = (allowedRoles) => {
    return (req, res, next) => {
        const userRoles = getUserRoles(req.user);
        if (!allowedRoles.some(role => userRoles.includes(role))) {
            return res.status(403).json({
                success: false,
                message: 'Insufficient permissions',
                required: allowedRoles,
                current: userRoles
            });
        }
        next();
    };
};

/**
 * @route GET /api/agencies/agents
 * @desc Get all agents across all agencies (for tenant admin) - MUST BE FIRST
 * @access TenantAdmin, SysAdmin
 */
router.get('/agents', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;
    
    const pool = await getPool();
    const request = pool.request();
    
    let whereClause = 'WHERE r.Name = \'Agent\' AND u.Status = \'Active\' AND a.Status = \'Active\'';
    
    // Tenant isolation
    if (!getUserRoles(req.user).includes('SysAdmin')) {
      request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      whereClause += ' AND u.TenantId = @TenantId';
    }
    
    // Status filter (additional)
    if (status && status !== 'Active') {
      request.input('Status', sql.NVarChar(20), status);
      whereClause += ' AND u.Status = @Status';
    }
    
    // Search filter
    if (search) {
      request.input('Search', sql.NVarChar(100), `%${search}%`);
      whereClause += ' AND (u.FirstName LIKE @Search OR u.LastName LIKE @Search OR u.Email LIKE @Search)';
    }
    
    console.log('🔍 WHERE clause:', whereClause);
    console.log('🔍 TenantId:', req.user.TenantId);
    
    // Pagination
    const offset = (page - 1) * limit;
    request.input('Offset', sql.Int, offset);
    request.input('Limit', sql.Int, parseInt(limit));
    
    const result = await request.query(`
      SELECT DISTINCT
        u.UserId,
        u.FirstName,
        u.LastName,
        u.Email,
        u.Status,
        u.TenantId,
        u.CreatedDate,
        u.LastLoginDate,
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
      ${whereClause}
      ORDER BY u.LastName, u.FirstName
      OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY
    `);
    
    // Get total count
    const countResult = await request.query(`
      SELECT COUNT(DISTINCT u.UserId) as TotalCount
      FROM oe.Users u
      INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId
      INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
      LEFT JOIN oe.Agents a ON u.UserId = a.UserId
      ${whereClause}
    `);
    
    console.log('✅ Agents query successful. Found:', result.recordset.length, 'agents');
    console.log('📊 First agent data:', JSON.stringify(result.recordset[0], null, 2));
    
    res.json({
      success: true,
      data: result.recordset,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult.recordset[0].TotalCount,
        pages: Math.ceil(countResult.recordset[0].TotalCount / limit)
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching agents:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch agents',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route GET /api/agencies
 * @desc Get all agencies for the current tenant
 * @access TenantAdmin, SysAdmin
 */
router.get('/', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;
    
    const pool = await getPool();
    const request = pool.request();
    
    // Build query with tenant isolation - using actual table structure
    let query = `
      SELECT 
        a.AgencyId,
        a.AgencyCode,
        a.AgencyName,
        a.AgencyType,
        a.Status,
        a.ContractDate,
        a.TerminationDate,
        a.Settings,
        a.CreatedDate,
        a.ModifiedDate,
        t.Name as TenantName,
        COUNT(ag.AgentId) as AgentCount
      FROM oe.Agencies a
      LEFT JOIN oe.Tenants t ON a.TenantId = t.TenantId
      LEFT JOIN oe.Agents ag ON a.AgencyId = ag.AgencyId 
        AND ag.Status = 'Active' 
        AND ag.TenantId = a.TenantId
      LEFT JOIN oe.Users u ON ag.UserId = u.UserId 
        AND u.Status = 'Active'
        AND u.TenantId = a.TenantId
      LEFT JOIN oe.UserRoles ur ON u.UserId = ur.UserId
      LEFT JOIN oe.Roles r ON ur.RoleId = r.RoleId AND r.Name = 'Agent'
    `;
    
    let whereConditions = [];
    
    // Tenant isolation
    if (!getUserRoles(req.user).includes('SysAdmin')) {
      whereConditions.push('a.TenantId = @TenantId');
      request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    }
    
    // Status filter
    if (status) {
      whereConditions.push('a.Status = @Status');
      request.input('Status', sql.NVarChar(20), status);
    }
    
    // Search filter
    if (search) {
      whereConditions.push('(a.AgencyName LIKE @Search OR a.AgencyCode LIKE @Search)');
      request.input('Search', sql.NVarChar(255), `%${search}%`);
    }
    
    // Add WHERE clause if conditions exist
    if (whereConditions.length > 0) {
      query += ' WHERE ' + whereConditions.join(' AND ');
    }
    
    // Add GROUP BY - using actual table structure
    query += ` 
      GROUP BY a.AgencyId, a.AgencyCode, a.AgencyName, a.AgencyType, a.Status,
               a.ContractDate, a.TerminationDate, a.Settings, a.CreatedDate, a.ModifiedDate, t.Name
    `;
    
    // Add ORDER BY
    query += ' ORDER BY a.AgencyName';
    
    // Add pagination
    const offset = (page - 1) * limit;
    query += ' OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY';
    request.input('Offset', sql.Int, offset);
    request.input('Limit', sql.Int, parseInt(limit));
    
    console.log('🔍 Executing agencies query for user:', req.user.Email, 'Roles:', getUserRoles(req.user));
    
    const result = await request.query(query);
    
    // Get total count for pagination
    let countQuery = `
      SELECT COUNT(DISTINCT a.AgencyId) as TotalCount
      FROM oe.Agencies a
      LEFT JOIN oe.Tenants t ON a.TenantId = t.TenantId
    `;
    
    if (whereConditions.length > 0) {
      countQuery += ' WHERE ' + whereConditions.join(' AND ');
    }
    
    const countRequest = pool.request();
    
    // Re-add parameters for count query
    if (!getUserRoles(req.user).includes('SysAdmin')) {
      countRequest.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    }
    if (status) {
      countRequest.input('Status', sql.NVarChar(20), status);
    }
    if (search) {
      countRequest.input('Search', sql.NVarChar(255), `%${search}%`);
    }
    
    const countResult = await countRequest.query(countQuery);
    
    console.log('✅ Agencies query successful. Found:', result.recordset.length, 'agencies');
    
    res.json({
      success: true,
      data: result.recordset,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult.recordset[0].TotalCount,
        pages: Math.ceil(countResult.recordset[0].TotalCount / limit)
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching agencies:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch agencies',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route POST /api/agencies
 * @desc Create new agency
 * @access TenantAdmin, SysAdmin
 */
router.post('/', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const {
      agencyCode,
      agencyName,
      agencyType,
      contractDate,
      terminationDate,
      settings,
      tenantId
    } = req.body;
    
    if (!agencyCode || !agencyName || !agencyType) {
      return res.status(400).json({
        success: false,
        message: 'agencyCode, agencyName, and agencyType are required'
      });
    }
    
    const pool = await getPool();
    const request = pool.request();
    
    const agencyId = require('uuid').v4();
    
    // Use request tenant unless SysAdmin specifies different tenant
    const finalTenantId = (getUserRoles(req.user).includes('SysAdmin') && tenantId) 
      ? tenantId 
      : req.user.TenantId;
    
    request.input('AgencyId', sql.UniqueIdentifier, agencyId);
    request.input('AgencyCode', sql.NVarChar(50), agencyCode);
    request.input('AgencyName', sql.NVarChar(200), agencyName);
    request.input('AgencyType', sql.NVarChar(50), agencyType);
    request.input('TenantId', sql.UniqueIdentifier, finalTenantId);
    request.input('ContractDate', sql.Date, contractDate);
    request.input('TerminationDate', sql.Date, terminationDate);
    request.input('Settings', sql.NVarChar(sql.MAX), settings);
    request.input('CreatedBy', sql.UniqueIdentifier, req.user.UserId);
    
    // Check for duplicate agency code
    const duplicateCheck = await request.query(`
      SELECT COUNT(*) as Count
      FROM oe.Agencies
      WHERE AgencyCode = @AgencyCode AND TenantId = @TenantId
    `);
    
    if (duplicateCheck.recordset[0].Count > 0) {
      return res.status(409).json({
        success: false,
        message: 'Agency code already exists'
      });
    }
    
    await request.query(`
      INSERT INTO oe.Agencies (
        AgencyId, AgencyCode, AgencyName, AgencyType, TenantId,
        ContractDate, TerminationDate, Settings,
        Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
      ) VALUES (
        @AgencyId, @AgencyCode, @AgencyName, @AgencyType, @TenantId,
        @ContractDate, @TerminationDate, @Settings,
        'Active', GETUTCDATE(), GETUTCDATE(), @CreatedBy, @CreatedBy
      )
    `);
    
    console.log('✅ Agency created:', { 
      agencyId, 
      agencyCode, 
      agencyName, 
      createdBy: req.user.UserId 
    });
    
    res.status(201).json({
      success: true,
      agencyId,
      message: 'Agency created successfully'
    });
    
  } catch (error) {
    console.error('❌ Error creating agency:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create agency',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route GET /api/agencies/:agencyId
 * @desc Get single agency with details
 * @access TenantAdmin, SysAdmin, Agent (if belongs to agency)
 */
router.get('/:agencyId', authorize(['TenantAdmin', 'SysAdmin', 'Agent']), async (req, res) => {
  try {
    const { agencyId } = req.params;
    
    const pool = await getPool();
    const request = pool.request();
    
    request.input('AgencyId', sql.UniqueIdentifier, agencyId);
    
    let whereClause = 'WHERE a.AgencyId = @AgencyId';
    
    // Tenant isolation
    if (!getUserRoles(req.user).includes('SysAdmin')) {
      request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      whereClause += ' AND a.TenantId = @TenantId';
    }
    
    // Agent can only see their own agency
    if (getUserRoles(req.user).includes('Agent')) {
      request.input('UserAgencyId', sql.UniqueIdentifier, req.user.AgencyId);
      whereClause += ' AND a.AgencyId = @UserAgencyId';
    }
    
    const result = await request.query(`
      SELECT 
        a.AgencyId,
        a.AgencyCode,
        a.AgencyName,
        a.AgencyType,
        a.Status,
        a.ContractDate,
        a.TerminationDate,
        a.Settings,
        a.CreatedDate,
        a.ModifiedDate,
        t.Name as TenantName,
        COUNT(ag.AgentId) as AgentCount
      FROM oe.Agencies a
      LEFT JOIN oe.Tenants t ON a.TenantId = t.TenantId
      LEFT JOIN oe.Agents ag ON a.AgencyId = ag.AgencyId 
        AND ag.Status = 'Active' 
        AND ag.TenantId = a.TenantId
      LEFT JOIN oe.Users u ON ag.UserId = u.UserId 
        AND u.Status = 'Active'
        AND u.TenantId = a.TenantId
      LEFT JOIN oe.UserRoles ur ON u.UserId = ur.UserId
      LEFT JOIN oe.Roles r ON ur.RoleId = r.RoleId AND r.Name = 'Agent'
      ${whereClause}
      GROUP BY a.AgencyId, a.AgencyCode, a.AgencyName, a.AgencyType, a.Status,
               a.ContractDate, a.TerminationDate, a.Settings, a.CreatedDate, a.ModifiedDate, t.Name
    `);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agency not found'
      });
    }
    
    res.json({
      success: true,
      data: result.recordset[0]
    });
    
  } catch (error) {
    console.error('❌ Error fetching agency:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch agency',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route PUT /api/agencies/:agencyId
 * @desc Update agency details
 * @access TenantAdmin, SysAdmin
 */
router.put('/:agencyId', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const pool = await getPool();
    const request = pool.request();
    
    // Build dynamic update query
    const updateFields = [];
    const allowedFields = [
      'AgencyName', 'AgencyType', 'Status', 'ContractDate', 'TerminationDate', 'Settings'
    ];
    
    request.input('AgencyId', sql.UniqueIdentifier, agencyId);
    request.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
    
    // Tenant isolation
    if (!getUserRoles(req.user).includes('SysAdmin')) {
      request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
    }
    
    for (const field of allowedFields) {
      const camelCase = field.charAt(0).toLowerCase() + field.slice(1);
      if (req.body.hasOwnProperty(camelCase)) {
        updateFields.push(`${field} = @${field}`);
        
        let sqlType = sql.NVarChar(200);
        if (field === 'AgencyName') sqlType = sql.NVarChar(200);
        else if (field === 'AgencyType') sqlType = sql.NVarChar(50);
        else if (field === 'Status') sqlType = sql.NVarChar(20);
        else if (field === 'ContractDate') sqlType = sql.Date;
        else if (field === 'TerminationDate') sqlType = sql.Date;
        else if (field === 'Settings') sqlType = sql.NVarChar(sql.MAX);
        
        request.input(field, sqlType, req.body[camelCase]);
      }
    }
    
    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }
    
    let whereClause = 'WHERE AgencyId = @AgencyId';
    if (!getUserRoles(req.user).includes('SysAdmin')) {
      whereClause += ' AND TenantId = @TenantId';
    }
    
    const updateResult = await request.query(`
      UPDATE oe.Agencies 
      SET ${updateFields.join(', ')}, 
          ModifiedDate = GETUTCDATE(),
          ModifiedBy = @ModifiedBy
      ${whereClause}
    `);
    
    if (updateResult.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agency not found or unauthorized'
      });
    }
    
    console.log('✅ Agency updated:', { 
      agencyId, 
      updatedFields: updateFields,
      modifiedBy: req.user.UserId 
    });
    
    res.json({
      success: true,
      message: 'Agency updated successfully'
    });
    
  } catch (error) {
    console.error('❌ Error updating agency:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update agency',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * @route DELETE /api/agencies/:agencyId
 * @desc Delete agency (soft delete)
 * @access TenantAdmin, SysAdmin
 */
router.delete('/:agencyId', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { agencyId } = req.params;
    const pool = await getPool();
    const request = pool.request();
    
    request.input('AgencyId', sql.UniqueIdentifier, agencyId);
    request.input('ModifiedBy', sql.UniqueIdentifier, req.user.UserId);
    
    let whereClause = 'WHERE AgencyId = @AgencyId';
    if (!getUserRoles(req.user).includes('SysAdmin')) {
      request.input('TenantId', sql.UniqueIdentifier, req.user.TenantId);
      whereClause += ' AND TenantId = @TenantId';
    }
    
    const updateResult = await request.query(`
      UPDATE oe.Agencies 
      SET Status = 'Inactive', 
          ModifiedDate = GETUTCDATE(),
          ModifiedBy = @ModifiedBy
      ${whereClause}
    `);
    
    if (updateResult.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agency not found or unauthorized'
      });
    }
    
    console.log('✅ Agency deleted (soft):', { 
      agencyId, 
      modifiedBy: req.user.UserId 
    });
    
    res.json({
      success: true,
      message: 'Agency deleted successfully'
    });
    
  } catch (error) {
    console.error('❌ Error deleting agency:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete agency',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;