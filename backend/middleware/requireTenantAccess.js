// backend/src/middleware/requireTenantAccess.js
const { getPool } = require('../config/database');
const sql = require('mssql');
const { getUserRoles } = require('./auth');
const { tenantIdsMatch, userHasTenantAccess } = require('../utils/tenantIds');

/**
 * Middleware to ensure tenant access isolation
 * This middleware:
 * 1. Verifies the user exists and is active
 * 2. Sets req.tenantId from the database (never trust frontend)
 * 3. Ensures tenant-level data isolation
 */
const requireTenantAccess = async (req, res, next) => {
  try {
    // Ensure user is authenticated (should be handled by auth middleware first)
    if (!req.user || !req.user.UserId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
        code: 'AUTH_REQUIRED'
      });
    }

    const pool = await getPool();
    
    // Get user's tenant information from the database (including AdditionalTenants)
    const userQuery = await pool.request()
      .input('userId', sql.NVarChar(36), req.user.UserId)
      .query(`
        SELECT 
          u.TenantId, 
          u.AdditionalTenants,
          u.Status,
          u.Email,
          t.Name as TenantName,
          t.Status as TenantStatus
        FROM oe.Users u
        INNER JOIN oe.Tenants t ON u.TenantId = t.TenantId
        WHERE u.UserId = @userId
      `);

    if (userQuery.recordset.length === 0) {
      console.warn(`🚨 User not found in database: ${req.user.UserId}`);
      return res.status(403).json({
        success: false,
        message: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    const userRecord = userQuery.recordset[0];
    
    // Check if user is active
    if (userRecord.Status !== 'Active') {
      console.warn(`🚨 Inactive user attempted access: ${userRecord.Email}`);
      return res.status(403).json({
        success: false,
        message: 'User account is not active',
        code: 'USER_INACTIVE'
      });
    }

    // Parse AdditionalTenants from JSON string if present
    let additionalTenants = [];
    if (userRecord.AdditionalTenants) {
      try {
        additionalTenants = JSON.parse(userRecord.AdditionalTenants);
      } catch (e) {
        console.warn('Failed to parse AdditionalTenants for user:', userRecord.Email);
      }
    }

    // Get user roles to check if SysAdmin (can access any tenant)
    const userRoles = getUserRoles(req.user);
    const isSysAdmin = userRoles.includes('SysAdmin');
    
    // Get requested tenant ID from header, query, or body (for tenant switching)
    // Express normalizes headers to lowercase, so check both lowercase and original case
    const headerTenantId = req.headers['x-current-tenant-id'] || req.headers['X-Current-Tenant-Id'];
    const requestedTenantId = headerTenantId || 
                              req.query.currentTenantId || 
                              req.query.tenantId || 
                              req.body.currentTenantId || 
                              req.body.tenantId;
    
    // DEBUG: Log tenant switching details
    console.log('🔍 [requireTenantAccess] Tenant switching check:', {
      userId: req.user?.UserId,
      userEmail: userRecord.Email,
      primaryTenantId: userRecord.TenantId,
      primaryTenantName: userRecord.TenantName,
      additionalTenants: additionalTenants,
      headerTenantId: headerTenantId,
      requestedTenantId: requestedTenantId,
      allHeaders: Object.keys(req.headers).filter(k => k.toLowerCase().includes('tenant')),
      'x-current-tenant-id': req.headers['x-current-tenant-id'],
      'X-Current-Tenant-Id': req.headers['X-Current-Tenant-Id']
    });
    
    // Determine which tenant to use
    let activeTenantId = userRecord.TenantId; // Default to primary tenant
    let activeTenantName = userRecord.TenantName;
    
    // If a tenant is requested and user has access to it, use that tenant
    if (requestedTenantId) {
      const hasRequestedTenantAccess = userHasTenantAccess(
        requestedTenantId,
        userRecord.TenantId,
        additionalTenants
      );

      // SysAdmin can access any tenant
      if (isSysAdmin || hasRequestedTenantAccess) {
        // User has access to this tenant, fetch its details
        const tenantQuery = await pool.request()
          .input('tenantId', sql.UniqueIdentifier, requestedTenantId)
          .query(`
            SELECT TenantId, Name, Status
            FROM oe.Tenants
            WHERE TenantId = @tenantId
          `);
        
        if (tenantQuery.recordset.length > 0) {
          const requestedTenant = tenantQuery.recordset[0];
          
          // Check if requested tenant is active
          if (requestedTenant.Status !== 'Active') {
            console.warn(`🚨 Inactive tenant attempted access: ${requestedTenant.Name}`);
            return res.status(403).json({
              success: false,
              message: 'Requested tenant account is not active',
              code: 'TENANT_INACTIVE'
            });
          }
          
          activeTenantId = requestedTenantId;
          activeTenantName = requestedTenant.Name;
          console.log(`✅ [requireTenantAccess] Tenant switched successfully: ${userRecord.TenantName} -> ${activeTenantName} (${activeTenantId})`);
        } else {
          // Requested tenant doesn't exist
          console.warn(`🚨 Invalid tenant requested: ${requestedTenantId}`);
          return res.status(403).json({
            success: false,
            message: 'Invalid tenant requested',
            code: 'INVALID_TENANT'
          });
        }
      } else {
        // User doesn't have access to requested tenant
        console.warn(`🚨 Tenant access denied: User ${userRecord.Email} attempted to access tenant ${requestedTenantId}`, {
          primaryTenant: userRecord.TenantId,
          additionalTenants: additionalTenants,
          requestedTenant: requestedTenantId
        });
        return res.status(403).json({
          success: false,
          message: 'Access denied to requested tenant',
          code: 'TENANT_ACCESS_DENIED'
        });
      }
    } else if (isSysAdmin) {
      // SysAdmin without tenantId - allow but warn (they should provide tenantId)
      console.warn(`⚠️ SysAdmin accessing route without explicit tenantId, using primary tenant: ${userRecord.TenantId}`);
    } else {
      // No tenant requested, using primary tenant
      console.log(`ℹ️ [requireTenantAccess] No tenant switch requested, using primary tenant: ${userRecord.TenantName} (${userRecord.TenantId})`);
    }

    // Check if primary tenant is active (always check primary tenant status)
    if (userRecord.TenantStatus !== 'Active') {
      console.warn(`🚨 Inactive primary tenant: ${userRecord.TenantName}`);
      return res.status(403).json({
        success: false,
        message: 'Primary tenant account is not active',
        code: 'TENANT_INACTIVE'
      });
    }

    // Set tenant context (using active tenant, which may be primary or additional)
    // CRITICAL: Always set these values - don't allow them to be overwritten
    req.tenantId = activeTenantId;
    req.tenantName = activeTenantName;
    
    // IMPORTANT: Also update req.user.TenantId to the active tenant
    // This ensures existing code using req.user.TenantId automatically works with tenant switching
    // without needing to update every endpoint
    // CRITICAL: Overwrite req.user.TenantId to ensure tenant switching works
    req.user.TenantId = activeTenantId;
    req.user.TenantName = activeTenantName;
    
    // CRITICAL: Store the original tenant ID to detect if it gets overwritten
    req._originalTenantId = activeTenantId;

    // Use userRoles already declared above for audit log
    const rolesStr = userRoles.length > 0 ? userRoles.join(', ') : 'No roles';

    // Log access for audit trail with detailed context
    console.log(`🔒 [requireTenantAccess] Tenant access granted: User ${userRecord.Email} (${rolesStr}) accessing tenant ${activeTenantName} (${activeTenantId})`, {
      wasSwitched: requestedTenantId && !tenantIdsMatch(requestedTenantId, userRecord.TenantId),
      originalTenant: userRecord.TenantId,
      activeTenant: activeTenantId,
      'req.tenantId SET TO': req.tenantId,
      'req.user.TenantId SET TO': req.user.TenantId,
      'req.tenantName SET TO': req.tenantName
    });

    // CRITICAL: Verify the values are set correctly before calling next()
    if (req.tenantId !== activeTenantId) {
      console.error(`🚨 CRITICAL ERROR: req.tenantId mismatch! Expected ${activeTenantId}, but req.tenantId is ${req.tenantId}`);
    }
    if (req.user.TenantId !== activeTenantId) {
      console.error(`🚨 CRITICAL ERROR: req.user.TenantId mismatch! Expected ${activeTenantId}, but req.user.TenantId is ${req.user.TenantId}`);
    }

    next();
  } catch (error) {
    console.error('❌ Error in requireTenantAccess middleware:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify tenant access',
      code: 'TENANT_ACCESS_ERROR'
    });
  }
};

module.exports = requireTenantAccess;