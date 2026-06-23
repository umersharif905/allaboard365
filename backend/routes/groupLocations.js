// File: backend/routes/groupLocations.js
// Group Locations API Routes
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize, requireTenantAccess, getUserRoles } = require('../middleware/auth');
const PaymentMethodService = require('../services/PaymentMethodService');
const { getAccessibleAgentIdsForUser, buildAgentScopeClause } = require('../utils/agentGroupAccess');
const VendorGroupIdService = require('../services/vendorGroupIdService');
const groupMasterIdService = require('../services/groupMasterIdService');

/**
 * Helper function to verify group access based on user role
 * @param {object} pool - Database pool
 * @param {string} groupId - Group ID to verify access for
 * @param {object} user - User object from req.user
 * @returns {Promise<{hasAccess: boolean, group: object}>}
 */
async function verifyGroupAccess(pool, groupId, user) {
  // Use currentRole instead of all roles to avoid conflicts when user has multiple roles
  const currentRole = user.currentRole || (getUserRoles(user)[0]);
  
  console.log(`🔐 Verifying group access for user ${user.UserId} with currentRole: ${currentRole}`);
  
  // SysAdmin has access to all groups
  if (currentRole === 'SysAdmin') {
    const request = pool.request();
    request.input('groupId', sql.UniqueIdentifier, groupId);
    const result = await request.query(`
      SELECT GroupId, TenantId, AgentId 
      FROM oe.Groups 
      WHERE GroupId = @groupId
    `);
    
    console.log(`✅ SysAdmin access granted for group ${groupId}`);
    return {
      hasAccess: result.recordset.length > 0,
      group: result.recordset[0] || null
    };
  }
  
  // Build query based on current role
  let query = `
    SELECT g.GroupId, g.TenantId, g.AgentId
    FROM oe.Groups g
    WHERE g.GroupId = @groupId
  `;
  
  const request = pool.request();
  request.input('groupId', sql.UniqueIdentifier, groupId);
  
  if (currentRole === 'GroupAdmin') {
    // GroupAdmin: Query from GroupAdmins table to find user's assigned group
    let userGroupId = user.GroupId || user.groupId;
    
    console.log(`🔍 Initial GroupAdmin check:`, {
      userId: user.UserId,
      userGroupIdFromJWT: userGroupId,
      requestedGroupId: groupId
    });
    
    // If GroupId not in JWT, query from GroupAdmins table
    if (!userGroupId) {
      const groupIdQuery = `
        SELECT GroupId 
        FROM oe.GroupAdmins 
        WHERE UserId = @userId AND Status = 'Active'
      `;
      const groupIdRequest = pool.request();
      groupIdRequest.input('userId', sql.UniqueIdentifier, user.UserId);
      const groupIdResult = await groupIdRequest.query(groupIdQuery);
      
      if (groupIdResult.recordset.length > 0 && groupIdResult.recordset[0].GroupId) {
        userGroupId = groupIdResult.recordset[0].GroupId;
        console.log(`🔍 Retrieved GroupId from GroupAdmins table: ${userGroupId}`);
      } else {
        console.log(`❌ No GroupId found in GroupAdmins table for UserId: ${user.UserId}`);
      }
    }
    
    if (!userGroupId) {
      console.log(`❌ GroupAdmin has no group assigned - access denied`);
      return { hasAccess: false, group: null };
    }
    
    query += ` AND g.GroupId = @userGroupId`;
    request.input('userGroupId', sql.UniqueIdentifier, userGroupId);
    console.log(`🔍 Checking GroupAdmin access: userGroupId = ${userGroupId}, requestedGroupId = ${groupId}`);
  } else if (currentRole === 'Agent') {
    const accessibleAgentIds = await getAccessibleAgentIdsForUser(pool, user);
    const agentScopeClause = buildAgentScopeClause(request, accessibleAgentIds, 'g.AgentId', 'agLoc');
    query += ` AND ${agentScopeClause}`;
    console.log(`🔍 Checking Agent access with scoped agents: ${accessibleAgentIds.length}`);
  } else if (currentRole === 'TenantAdmin') {
    // TenantAdmin: Must match TenantId
    query += ` AND g.TenantId = @userTenantId`;
    request.input('userTenantId', sql.UniqueIdentifier, user.TenantId);
    console.log(`🔍 Checking TenantAdmin access: user.TenantId = ${user.TenantId}`);
  } else {
    console.log(`⚠️ Unknown role: ${currentRole}`);
    return { hasAccess: false, group: null };
  }
  
  const result = await request.query(query);
  
  if (result.recordset.length > 0) {
    console.log(`✅ Access granted for ${currentRole} to group ${groupId}`);
  } else {
    console.log(`❌ Access denied for ${currentRole} to group ${groupId}`);
  }
  
  return {
    hasAccess: result.recordset.length > 0,
    group: result.recordset[0] || null
  };
}

// GET /api/groups/:groupId/locations - Get all locations for a group
router.get('/:groupId/locations', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const pool = await getPool();
    
    // Verify group access based on role
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }
    
    // Get locations
    const locationsRequest = pool.request();
    locationsRequest.input('groupId', sql.UniqueIdentifier, groupId);
    
    const locationsQuery = `
      SELECT 
        LocationId,
        GroupId,
        Name,
        Address,
        Address2,
        City,
        State,
        Zip,
        ContactName,
        ContactPhone,
        ContactEmail,
        UseLocationACH,
        IsPrimary,
        Status,
        CreatedDate,
        ModifiedDate,
        CreatedBy,
        ModifiedBy
      FROM oe.GroupLocations
      WHERE GroupId = @groupId
      ORDER BY IsPrimary DESC, CreatedDate ASC
    `;
    
    const result = await locationsRequest.query(locationsQuery);
    
    // Attach per-location vendor location IDs (keyed by vendorId) when they exist
    const locations = result.recordset || [];
    const locationIds = locations.map(l => l.LocationId).filter(Boolean);
    let vendorLocationIdsByLocation = {};
    if (locationIds.length > 0) {
      try {
        // Build parameterised IN clause
        const lviRequest = pool.request();
        const paramNames = locationIds.map((id, i) => {
          lviRequest.input(`loc${i}`, sql.UniqueIdentifier, id);
          return `@loc${i}`;
        });
        const lviResult = await lviRequest.query(`
          SELECT lvi.LocationId, lvi.VendorId, lvi.VendorLocationId,
                 lvi.IsAutoGenerated, v.VendorName
          FROM oe.GroupLocationVendorIds lvi
          INNER JOIN oe.Vendors v ON lvi.VendorId = v.VendorId
          WHERE lvi.LocationId IN (${paramNames.join(',')}) AND lvi.IsActive = 1
        `);
        for (const row of lviResult.recordset || []) {
          const locKey = String(row.LocationId);
          if (!vendorLocationIdsByLocation[locKey]) vendorLocationIdsByLocation[locKey] = [];
          vendorLocationIdsByLocation[locKey].push({
            VendorId: row.VendorId,
            VendorName: row.VendorName,
            VendorLocationId: row.VendorLocationId,
            IsAutoGenerated: row.IsAutoGenerated,
          });
        }
      } catch (lviError) {
        console.warn('⚠️ Could not fetch vendor location IDs:', lviError.message);
      }
    }

    const enrichedLocations = locations.map(loc => ({
      ...loc,
      VendorLocationIds: vendorLocationIdsByLocation[String(loc.LocationId)] || [],
    }));

    res.json({
      success: true,
      data: enrichedLocations
    });
  } catch (error) {
    console.error('❌ Error fetching group locations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch group locations',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /api/groups/:groupId/locations/:locationId - Get single location
router.get('/:groupId/locations/:locationId', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, locationId } = req.params;
    const pool = await getPool();
    
    // Verify group access based on role
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }
    
    // Get location
    const locationRequest = pool.request();
    locationRequest.input('groupId', sql.UniqueIdentifier, groupId);
    locationRequest.input('locationId', sql.UniqueIdentifier, locationId);
    
    const locationQuery = `
      SELECT 
        LocationId,
        GroupId,
        Name,
        Address,
        Address2,
        City,
        State,
        Zip,
        ContactName,
        ContactPhone,
        ContactEmail,
        UseLocationACH,
        IsPrimary,
        Status,
        CreatedDate,
        ModifiedDate,
        CreatedBy,
        ModifiedBy
      FROM oe.GroupLocations
      WHERE GroupId = @groupId AND LocationId = @locationId
    `;
    
    const result = await locationRequest.query(locationQuery);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Location not found'
      });
    }
    
    res.json({
      success: true,
      data: result.recordset[0]
    });
  } catch (error) {
    console.error('❌ Error fetching group location:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch group location',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST /api/groups/:groupId/locations - Create a new location
router.post('/:groupId/locations', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const {
      name,
      address,
      address2,
      city,
      state,
      zip,
      contactName,
      contactPhone,
      contactEmail,
      useLocationACH
    } = req.body;
    
    const pool = await getPool();
    
    // Validate required fields
    if (!address || !city || !state || !zip) {
      return res.status(400).json({
        success: false,
        message: 'Address, City, State, and Zip are required'
      });
    }
    
    // Validate contact info (required for invoice delivery)
    if (!contactName || !contactName.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Contact name is required for invoice delivery and billing notifications'
      });
    }
    
    if (!contactEmail || !contactEmail.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Contact email is required for invoice delivery and billing notifications'
      });
    }
    
    // Verify group access based on role
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }
    
    // Check if this is the first location for the group
    const countRequest = pool.request();
    countRequest.input('groupId', sql.UniqueIdentifier, groupId);
    const countResult = await countRequest.query(`
      SELECT COUNT(*) as locationCount
      FROM oe.GroupLocations
      WHERE GroupId = @groupId
    `);
    
    const locationCount = countResult.recordset[0].locationCount;
    const isPrimary = locationCount === 0; // First location is automatically primary
    
    console.log(`🔍 Creating location for group ${groupId}. Existing locations: ${locationCount}, Setting as primary: ${isPrimary}`);
    
    // Create location
    const locationId = require('crypto').randomUUID();
    const createRequest = pool.request();
    createRequest.input('locationId', sql.UniqueIdentifier, locationId);
    createRequest.input('groupId', sql.UniqueIdentifier, groupId);
    createRequest.input('name', sql.NVarChar, name || null);
    createRequest.input('address', sql.NVarChar, address);
    createRequest.input('address2', sql.NVarChar, address2 || null);
    createRequest.input('city', sql.NVarChar, city);
    createRequest.input('state', sql.NVarChar, state);
    createRequest.input('zip', sql.NVarChar, zip);
    createRequest.input('contactName', sql.NVarChar, contactName || null);
    createRequest.input('contactPhone', sql.NVarChar, contactPhone || null);
    createRequest.input('contactEmail', sql.NVarChar, contactEmail || null);
    createRequest.input('useLocationACH', sql.Bit, useLocationACH || false);
    createRequest.input('isPrimary', sql.Bit, isPrimary);
    createRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
    
    const createQuery = `
      INSERT INTO oe.GroupLocations (
        LocationId, GroupId, Name, Address, Address2, City, State, Zip,
        ContactName, ContactPhone, ContactEmail, UseLocationACH, IsPrimary, Status,
        CreatedDate, ModifiedDate, CreatedBy
      ) VALUES (
        @locationId, @groupId, @name, @address, @address2, @city, @state, @zip,
        @contactName, @contactPhone, @contactEmail, @useLocationACH, @isPrimary, 'Active',
        GETDATE(), GETDATE(), @createdBy
      )
    `;
    
    await createRequest.query(createQuery);
    
    // Fetch the created location
    const fetchRequest = pool.request();
    fetchRequest.input('locationId', sql.UniqueIdentifier, locationId);
    const fetchResult = await fetchRequest.query(`
      SELECT * FROM oe.GroupLocations WHERE LocationId = @locationId
    `);

    // Auto-generate location vendor IDs for any vendor with LocationVendorGroupIdsEnabled on this group
    const groupForTenant = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`SELECT TenantId FROM oe.Groups WHERE GroupId = @groupId`);
    const newLocTenantId = groupForTenant.recordset[0]?.TenantId;
    if (newLocTenantId) {
      const userId = req.user?.UserId || req.user?.userId;
      VendorGroupIdService.autoGenerateForNewLocation(groupId, locationId, newLocTenantId, userId)
        .catch(e => console.warn('⚠️ auto-generate location vendor IDs failed:', e.message));
    }

    // Recompute AllAboard location group IDs when a new location is added
    groupMasterIdService.recomputeLocationGroupIds(groupId)
      .catch(e => console.warn('⚠️ recompute AllAboard location group IDs failed:', e.message));
    
    res.status(201).json({
      success: true,
      message: 'Location created successfully',
      data: fetchResult.recordset[0]
    });
  } catch (error) {
    console.error('❌ Error creating group location:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create location',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// PUT /api/groups/:groupId/locations/:locationId - Update a location
router.put('/:groupId/locations/:locationId', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, locationId } = req.params;
    const {
      name,
      address,
      address2,
      city,
      state,
      zip,
      contactName,
      contactPhone,
      contactEmail,
      useLocationACH,
      status
    } = req.body;
    
    const pool = await getPool();
    
    // Validate required fields
    if (!address || !city || !state || !zip) {
      return res.status(400).json({
        success: false,
        message: 'Address, City, State, and Zip are required'
      });
    }
    
    // Validate contact info (required for invoice delivery)
    if (!contactName || !contactName.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Contact name is required for invoice delivery and billing notifications'
      });
    }
    
    if (!contactEmail || !contactEmail.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Contact email is required for invoice delivery and billing notifications'
      });
    }
    
    // Verify group access based on role
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }
    
    // If UseLocationACH is checked, validate that at least one payment method exists
    if (useLocationACH) {
      const paymentMethodCheckRequest = pool.request();
      paymentMethodCheckRequest.input('locationId', sql.UniqueIdentifier, locationId);
      paymentMethodCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
      
      const paymentMethodCheckResult = await paymentMethodCheckRequest.query(`
        SELECT COUNT(*) as count
        FROM oe.GroupPaymentMethods
        WHERE LocationId = @locationId
          AND GroupId = @groupId
          AND Status = 'Active'
      `);
      
      const activePaymentMethodCount = paymentMethodCheckResult.recordset[0].count;
      
      if (activePaymentMethodCount === 0) {
        return res.status(400).json({
          success: false,
          message: 'At least one active payment method is required when location pays for its own members. Please add a payment method in the Payment Methods tab.',
          error: {
            message: 'No active payment methods found',
            code: 'PAYMENT_METHOD_REQUIRED'
          }
        });
      }
    }
    
    // Verify location belongs to group
    const verifyRequest = pool.request();
    verifyRequest.input('groupId', sql.UniqueIdentifier, groupId);
    verifyRequest.input('locationId', sql.UniqueIdentifier, locationId);
    
    const verifyResult = await verifyRequest.query(`
      SELECT LocationId, GroupId
      FROM oe.GroupLocations
      WHERE LocationId = @locationId AND GroupId = @groupId
    `);
    
    if (verifyResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Location not found'
      });
    }
    
    // Update location (IsPrimary is handled by separate endpoint)
    const updateRequest = pool.request();
    updateRequest.input('locationId', sql.UniqueIdentifier, locationId);
    updateRequest.input('name', sql.NVarChar, name || null);
    updateRequest.input('address', sql.NVarChar, address);
    updateRequest.input('address2', sql.NVarChar, address2 || null);
    updateRequest.input('city', sql.NVarChar, city);
    updateRequest.input('state', sql.NVarChar, state);
    updateRequest.input('zip', sql.NVarChar, zip);
    updateRequest.input('contactName', sql.NVarChar, contactName || null);
    updateRequest.input('contactPhone', sql.NVarChar, contactPhone || null);
    updateRequest.input('contactEmail', sql.NVarChar, contactEmail || null);
    updateRequest.input('useLocationACH', sql.Bit, useLocationACH || false);
    updateRequest.input('status', sql.NVarChar, status || 'Active');
    updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
    
    const updateQuery = `
      UPDATE oe.GroupLocations
      SET 
        Name = @name,
        Address = @address,
        Address2 = @address2,
        City = @city,
        State = @state,
        Zip = @zip,
        ContactName = @contactName,
        ContactPhone = @contactPhone,
        ContactEmail = @contactEmail,
        UseLocationACH = @useLocationACH,
        Status = @status,
        ModifiedDate = GETDATE(),
        ModifiedBy = @modifiedBy
      WHERE LocationId = @locationId
    `;
    
    await updateRequest.query(updateQuery);
    
    // Fetch the updated location
    const fetchRequest = pool.request();
    fetchRequest.input('locationId', sql.UniqueIdentifier, locationId);
    const fetchResult = await fetchRequest.query(`
      SELECT * FROM oe.GroupLocations WHERE LocationId = @locationId
    `);
    
    res.json({
      success: true,
      message: 'Location updated successfully',
      data: fetchResult.recordset[0]
    });
  } catch (error) {
    console.error('❌ Error updating group location:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update location',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// PUT /api/groups/:groupId/locations/:locationId/set-primary - Set location as primary
router.put('/:groupId/locations/:locationId/set-primary', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, locationId } = req.params;
    const pool = await getPool();
    
    // Verify group access based on role
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }
    
    // Verify location belongs to group
    const verifyRequest = pool.request();
    verifyRequest.input('groupId', sql.UniqueIdentifier, groupId);
    verifyRequest.input('locationId', sql.UniqueIdentifier, locationId);
    
    const verifyResult = await verifyRequest.query(`
      SELECT LocationId, GroupId, Status
      FROM oe.GroupLocations
      WHERE LocationId = @locationId AND GroupId = @groupId
    `);
    
    if (verifyResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Location not found'
      });
    }
    
    if (verifyResult.recordset[0].Status !== 'Active') {
      return res.status(400).json({
        success: false,
        message: 'Cannot set inactive location as primary'
      });
    }
    
    // Use transaction to atomically update primary status
    const transaction = pool.transaction();
    await transaction.begin();
    
    try {
      // Unset IsPrimary on all locations for this group
      const unsetRequest = transaction.request();
      unsetRequest.input('groupId', sql.UniqueIdentifier, groupId);
      unsetRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
      
      await unsetRequest.query(`
        UPDATE oe.GroupLocations
        SET IsPrimary = 0, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
        WHERE GroupId = @groupId
      `);
      
      // Set specified location as primary
      const setPrimaryRequest = transaction.request();
      setPrimaryRequest.input('locationId', sql.UniqueIdentifier, locationId);
      setPrimaryRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
      
      await setPrimaryRequest.query(`
        UPDATE oe.GroupLocations
        SET IsPrimary = 1, ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy
        WHERE LocationId = @locationId
      `);
      
      await transaction.commit();
      
      console.log(`✅ Set location ${locationId} as primary for group ${groupId}`);
      
      res.json({
        success: true,
        message: 'Primary location updated successfully'
      });
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  } catch (error) {
    console.error('❌ Error setting primary location:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to set primary location',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// DELETE /api/groups/:groupId/locations/:locationId - Delete a location
router.delete('/:groupId/locations/:locationId', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, locationId } = req.params;
    const pool = await getPool();
    
    // Verify group access based on role
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }
    
    // Check total location count for the group
    const countRequest = pool.request();
    countRequest.input('groupId', sql.UniqueIdentifier, groupId);
    
    const countResult = await countRequest.query(`
      SELECT COUNT(*) as locationCount
      FROM oe.GroupLocations
      WHERE GroupId = @groupId AND Status = 'Active'
    `);
    
    const locationCount = countResult.recordset[0].locationCount;
    
    // Prevent deletion if this is the only location
    if (locationCount <= 1) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete the last location. Groups must have at least one location.',
        error: {
          code: 'LAST_LOCATION_DELETION_NOT_ALLOWED'
        }
      });
    }
    
    // Check if trying to delete primary location
    const locationRequest = pool.request();
    locationRequest.input('locationId', sql.UniqueIdentifier, locationId);
    locationRequest.input('groupId', sql.UniqueIdentifier, groupId);
    
    const locationResult = await locationRequest.query(`
      SELECT IsPrimary
      FROM oe.GroupLocations
      WHERE LocationId = @locationId AND GroupId = @groupId
    `);
    
    if (locationResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Location not found'
      });
    }
    
    const isPrimary = locationResult.recordset[0].IsPrimary;
    
    // Prevent deletion of primary location
    if (isPrimary) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete primary location. Please set another location as primary first.',
        error: {
          code: 'PRIMARY_LOCATION_DELETION_NOT_ALLOWED'
        }
      });
    }
    
    // Delete location
    const deleteRequest = pool.request();
    deleteRequest.input('locationId', sql.UniqueIdentifier, locationId);
    
    await deleteRequest.query(`
      DELETE FROM oe.GroupLocations WHERE LocationId = @locationId
    `);
    
    console.log(`✅ Deleted location ${locationId} from group ${groupId}`);

    // Recompute AllAboard location group IDs after deletion
    groupMasterIdService.recomputeLocationGroupIds(groupId)
      .catch(e => console.warn('⚠️ recompute AllAboard location group IDs after delete failed:', e.message));
    
    res.json({
      success: true,
      message: 'Location deleted successfully'
    });
  } catch (error) {
    console.error('❌ Error deleting group location:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete location',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /api/groups/:groupId/locations/:locationId/payment-methods - Get payment methods for a location
router.get('/:groupId/locations/:locationId/payment-methods', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, locationId } = req.params;
    const pool = await getPool();
    
    // Verify group access based on role
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }
    
    // Verify location belongs to group
    const verifyRequest = pool.request();
    verifyRequest.input('groupId', sql.UniqueIdentifier, groupId);
    verifyRequest.input('locationId', sql.UniqueIdentifier, locationId);
    
    const verifyResult = await verifyRequest.query(`
      SELECT LocationId
      FROM oe.GroupLocations
      WHERE LocationId = @locationId AND GroupId = @groupId
    `);
    
    if (verifyResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Location not found'
      });
    }
    
    // Get payment methods for this location
    const paymentMethodsRequest = pool.request();
    paymentMethodsRequest.input('groupId', sql.UniqueIdentifier, groupId);
    paymentMethodsRequest.input('locationId', sql.UniqueIdentifier, locationId);
    
    const paymentMethodsResult = await paymentMethodsRequest.query(`
      SELECT 
        PaymentMethodId,
        GroupId,
        LocationId,
        Type,
        CASE 
          WHEN Type = 'ACH' THEN AccountNumberLast4
          ELSE CardLast4
        END as Last4,
        BankName,
        CardBrand,
        ExpiryMonth,
        ExpiryYear,
        IsDefault,
        Status,
        CreatedDate,
        BillingAddress,
        BillingCity,
        BillingState,
        BillingZip,
        ProcessorToken,
        ProcessorCustomerId,
        ProcessorPaymentMethodId
      FROM oe.GroupPaymentMethods
      WHERE GroupId = @groupId 
        AND LocationId = @locationId
        AND Status = 'Active'
      ORDER BY IsDefault DESC, CreatedDate DESC
    `);
    
    res.json({
      success: true,
      data: paymentMethodsResult.recordset
    });
  } catch (error) {
    console.error('❌ Error fetching location payment methods:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch location payment methods',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST /api/groups/:groupId/locations/:locationId/payment-method - Add payment method for a location
router.post('/:groupId/locations/:locationId/payment-method', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, locationId } = req.params;
    const { 
      type, 
      bankName, 
      accountType, 
      routingNumber, 
      accountNumber,
      cardNumber,
      expiryMonth,
      expiryYear,
      cvv,
      cardholderName,
      billingAddress,
      billingCity,
      billingState,
      billingZip,
      phoneNumber
    } = req.body;
    const userId = req.user?.UserId || req.user?.userId;
    
    const pool = await getPool();
    
    // Verify group access based on role
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }
    
    // Verify location belongs to group and get location details
    const verifyRequest = pool.request();
    verifyRequest.input('groupId', sql.UniqueIdentifier, groupId);
    verifyRequest.input('locationId', sql.UniqueIdentifier, locationId);
    
    const verifyResult = await verifyRequest.query(`
      SELECT gl.LocationId, gl.ContactName, gl.ContactEmail, gl.ContactPhone, g.Name as GroupName
      FROM oe.GroupLocations gl
      JOIN oe.Groups g ON gl.GroupId = g.GroupId
      WHERE gl.LocationId = @locationId AND gl.GroupId = @groupId
    `);
    
    if (verifyResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Location not found'
      });
    }
    
    const location = verifyResult.recordset[0];
    const tenantId = location.TenantId;
    
    // Check payment method limit (2 per location)
    const countRequest = pool.request();
    countRequest.input('groupId', sql.UniqueIdentifier, groupId);
    countRequest.input('locationId', sql.UniqueIdentifier, locationId);
    
    const countResult = await countRequest.query(`
      SELECT COUNT(*) as count
      FROM oe.GroupPaymentMethods
      WHERE GroupId = @groupId 
        AND LocationId = @locationId
        AND Status = 'Active'
    `);
    
    const activeCount = countResult.recordset[0].count;
    console.log(`🔍 Location payment method count check: ${activeCount} active methods for location ${locationId}`);
    
    if (countResult.recordset[0].count >= 2) {
      return res.status(400).json({
        success: false,
        message: 'Maximum of 2 payment methods allowed per location',
        error: {
          message: 'Payment method limit reached',
          code: 'PAYMENT_METHOD_LIMIT_REACHED'
        }
      });
    }
    
    // Ensure DIME customer exists using unified service
    const customerData = {
      firstName: location.ContactName?.split(' ')[0] || 'Location',
      lastName: location.ContactName?.split(' ').slice(1).join(' ') || 'Admin',
      email: location.ContactEmail || 'location@example.com',
      phone: phoneNumber || location.ContactPhone || '+17707892072',
      billingAddress: billingAddress || '',
      billingCity: billingCity || '',
      billingState: billingState || '',
      billingZip: billingZip || '',
      billingCountry: 'US'
    };
    
    const customerResult = await PaymentMethodService.ensureDimeCustomer(customerData, 'group', groupId, tenantId);
    if (!customerResult.success) {
      return res.status(500).json({
        success: false,
        message: customerResult.error.message,
        error: {
          message: customerResult.error.message,
          code: customerResult.error.code || 'CUSTOMER_CREATION_ERROR'
        }
      });
    }
    
    const dimeCustomerId = customerResult.customerId;
    
    // Prepare payment method data for unified service
    const paymentMethodData = {
      paymentMethodType: type,
      bankName,
      accountType,
      routingNumber,
      accountNumber,
      accountHolderName: location.ContactName || 'Location Admin',
      cardNumber,
      expiryMonth: parseInt(expiryMonth),
      expiryYear: parseInt(expiryYear),
      cvv,
      cardholderName,
      billingAddress,
      billingAddress2: '',
      billingCity,
      billingState,
      billingZip,
      billingCountry: 'US'
    };
    
    // Validate payment method data
    const validation = PaymentMethodService.validatePaymentMethodData(paymentMethodData, type);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment method data',
        error: {
          message: 'Validation failed',
          code: 'VALIDATION_FAILED',
          details: validation.errors
        }
      });
    }
    
    // Create payment method with DIME using unified service
    const dimeResult = await PaymentMethodService.createPaymentMethod(paymentMethodData, dimeCustomerId, tenantId);
    
    if (!dimeResult.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to create payment method',
        error: {
          message: dimeResult.error.message,
          code: dimeResult.error.code || 'PAYMENT_METHOD_CREATION_ERROR'
        }
      });
    }
    
    // Insert payment method using unified service with locationId
    const insertResult = await PaymentMethodService.insertPaymentMethod(
      paymentMethodData, 
      'group', 
      groupId, 
      dimeResult, 
      userId,
      null, // tenantId
      null, // transaction
      locationId  // locationId for location-specific payment methods
    );
    
    if (!insertResult.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to save payment method to database',
        error: {
          message: insertResult.error.message,
          code: insertResult.error.code
        }
      });
    }
    
    // Update payment method defaults using unified service
    await PaymentMethodService.updatePaymentMethodDefaults('group', groupId, insertResult.paymentMethodId, userId, null, null, locationId);
    
    console.log('✅ Location payment method saved to database with DIME tokens');
    
    res.json({
      success: true,
      message: 'Payment method added successfully',
      data: {
        paymentMethodId: insertResult.paymentMethodId
      }
    });
  } catch (error) {
    console.error('❌ Error adding location payment method:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add payment method',
      error: {
        message: error.message,
        code: 'PAYMENT_METHOD_CREATION_ERROR'
      }
    });
  }
});

// DELETE /api/groups/:groupId/locations/:locationId/payment-methods/:paymentMethodId - Delete a location payment method
router.delete('/:groupId/locations/:locationId/payment-methods/:paymentMethodId', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, locationId, paymentMethodId } = req.params;
    const pool = await getPool();
    
    // Verify group access based on role
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }
    
    // Verify location belongs to group
    const verifyRequest = pool.request();
    verifyRequest.input('groupId', sql.UniqueIdentifier, groupId);
    verifyRequest.input('locationId', sql.UniqueIdentifier, locationId);
    
    const verifyResult = await verifyRequest.query(`
      SELECT LocationId
      FROM oe.GroupLocations
      WHERE LocationId = @locationId AND GroupId = @groupId
    `);
    
    if (verifyResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Location not found'
      });
    }
    
    // Check if location uses its own ACH account
    const locationRequest = pool.request();
    locationRequest.input('locationId', sql.UniqueIdentifier, locationId);
    const locationResult = await locationRequest.query(`
      SELECT UseLocationACH
      FROM oe.GroupLocations
      WHERE LocationId = @locationId
    `);
    
    const useLocationACH = locationResult.recordset[0]?.UseLocationACH || false;
    
    // If location uses its own ACH account, check if this is the last payment method
    if (useLocationACH) {
      const countRequest = pool.request();
      countRequest.input('locationId', sql.UniqueIdentifier, locationId);
      countRequest.input('groupId', sql.UniqueIdentifier, groupId);
      
      const countResult = await countRequest.query(`
        SELECT COUNT(*) as count
        FROM oe.GroupPaymentMethods
        WHERE LocationId = @locationId
          AND GroupId = @groupId
          AND Status = 'Active'
      `);
      
      const activeCount = countResult.recordset[0].count;
      
      if (activeCount <= 1) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete the last payment method. Locations with separate payment accounts must have at least one active payment method.',
          error: {
            message: 'Last payment method cannot be deleted',
            code: 'LAST_PAYMENT_METHOD_DELETION_NOT_ALLOWED'
          }
        });
      }
    }
    
    // Get payment method details to check if it's the default
    const paymentMethodRequest = pool.request();
    paymentMethodRequest.input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId);
    paymentMethodRequest.input('locationId', sql.UniqueIdentifier, locationId);
    
    const paymentMethodResult = await paymentMethodRequest.query(`
      SELECT IsDefault, ProcessorToken, ProcessorPaymentMethodId
      FROM oe.GroupPaymentMethods
      WHERE PaymentMethodId = @paymentMethodId
        AND LocationId = @locationId
        AND Status = 'Active'
    `);
    
    if (paymentMethodResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment method not found or already inactive'
      });
    }
    
    const paymentMethod = paymentMethodResult.recordset[0];
    const isDefault = paymentMethod.IsDefault;
    
    // Delete from DIME if it has processor tokens
    if (paymentMethod.ProcessorToken && paymentMethod.ProcessorPaymentMethodId) {
      try {
        const DimeService = require('../services/dimeService');
        const dimeResult = await DimeService.deletePaymentMethod(
          paymentMethod.ProcessorToken,
          paymentMethod.ProcessorPaymentMethodId
        );
        
        if (!dimeResult.success) {
          console.warn(`⚠️ Failed to delete payment method from DIME: ${dimeResult.message}`);
          // Continue with local deletion even if DIME deletion fails
        } else {
          console.log(`✅ Payment method deleted from DIME successfully`);
        }
      } catch (dimeError) {
        console.error('Error deleting payment method from DIME:', dimeError);
        // Continue with local deletion
      }
    }
    
    // Soft delete payment method (set status to Inactive)
    const deleteRequest = pool.request();
    deleteRequest.input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId);
    deleteRequest.input('locationId', sql.UniqueIdentifier, locationId);
    deleteRequest.input('userId', sql.UniqueIdentifier, req.user?.UserId || req.user?.userId);
    
    await deleteRequest.query(`
      UPDATE oe.GroupPaymentMethods
      SET Status = 'Inactive', ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
      WHERE PaymentMethodId = @paymentMethodId
        AND LocationId = @locationId
    `);
    
    // If we deleted the default payment method, set another one as default
    if (isDefault && useLocationACH) {
      const nextDefaultRequest = pool.request();
      nextDefaultRequest.input('locationId', sql.UniqueIdentifier, locationId);
      nextDefaultRequest.input('groupId', sql.UniqueIdentifier, groupId);
      
      const nextDefaultResult = await nextDefaultRequest.query(`
        SELECT TOP 1 PaymentMethodId 
        FROM oe.GroupPaymentMethods
        WHERE LocationId = @locationId
          AND GroupId = @groupId
          AND Status = 'Active'
        ORDER BY CreatedDate DESC
      `);
      
      if (nextDefaultResult.recordset.length > 0) {
        const setDefaultRequest = pool.request();
        setDefaultRequest.input('paymentMethodId', sql.UniqueIdentifier, nextDefaultResult.recordset[0].PaymentMethodId);
        setDefaultRequest.input('locationId', sql.UniqueIdentifier, locationId);
        setDefaultRequest.input('groupId', sql.UniqueIdentifier, groupId);
        setDefaultRequest.input('userId', sql.UniqueIdentifier, req.user?.UserId || req.user?.userId);
        
        await setDefaultRequest.query(`
          UPDATE oe.GroupPaymentMethods
          SET IsDefault = 1, ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
          WHERE PaymentMethodId = @paymentMethodId
            AND LocationId = @locationId
            AND GroupId = @groupId
        `);
      }
    }
    
    res.json({
      success: true,
      message: 'Payment method deleted successfully'
    });
  } catch (error) {
    console.error('❌ Error deleting location payment method:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete payment method',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// PUT /api/groups/:groupId/locations/:locationId/payment-methods/:paymentMethodId/set-default - Set default payment method
router.put('/:groupId/locations/:locationId/payment-methods/:paymentMethodId/set-default', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, locationId, paymentMethodId } = req.params;
    const userId = req.user?.UserId || req.user?.userId;
    const pool = await getPool();
    
    // Verify group access based on role
    const accessCheck = await verifyGroupAccess(pool, groupId, req.user);
    if (!accessCheck.hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to access this group'
      });
    }
    
    // Update payment method defaults using unified service
    await PaymentMethodService.updatePaymentMethodDefaults('group', groupId, paymentMethodId, userId, null, null, locationId);
    
    res.json({
      success: true,
      message: 'Default payment method updated successfully'
    });
  } catch (error) {
    console.error('❌ Error setting default payment method:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to set default payment method',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;

