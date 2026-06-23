// backend/services/shared/user-roles.service.js
const sql = require('mssql');
const { getPool } = require('../../config/database');

/**
 * Service for managing user roles using the new oe.UserRoles and oe.Roles tables
 * This replaces the old UserType and Roles field system
 */
class UserRolesService {
  /**
   * Get all roles for a specific user
   * @param {string} userId - The user's unique identifier
   * @returns {Promise<Array<{roleId: string, roleName: string, isSystemRole: boolean, tenantId: string|null}>>}
   */
  static async getUserRoles(userId) {
    const pool = await getPool();
    const request = pool.request();
    
    request.input('userId', sql.UniqueIdentifier, userId);
    
    const result = await request.query(`
      SELECT 
        r.RoleId,
        r.Name as RoleName,
        r.Description,
        r.TenantId,
        r.IsSystemRole,
        ur.CreatedDate as AssignedDate
      FROM oe.UserRoles ur
      INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
      WHERE ur.UserId = @userId
      ORDER BY 
        CASE r.Name
          WHEN 'SysAdmin' THEN 1
          WHEN 'TenantAdmin' THEN 2
          WHEN 'VendorAdmin' THEN 3
          WHEN 'VendorAgent' THEN 4
          WHEN 'Agent' THEN 5
          WHEN 'GroupAdmin' THEN 6
          WHEN 'Member' THEN 7
          ELSE 8
        END
    `);
    
    return result.recordset.map(role => ({
      roleId: role.RoleId,
      roleName: role.RoleName,
      description: role.Description,
      tenantId: role.TenantId,
      isSystemRole: role.IsSystemRole,
      assignedDate: role.AssignedDate
    }));
  }

  /**
   * Get role names only for a user (lightweight query)
   * @param {string} userId - The user's unique identifier
   * @returns {Promise<Array<string>>} Array of role names (e.g., ['TenantAdmin', 'Agent'])
   */
  static async getUserRoleNames(userId) {
    const pool = await getPool();
    const request = pool.request();
    
    request.input('userId', sql.UniqueIdentifier, userId);
    
    const result = await request.query(`
      SELECT r.Name
      FROM oe.UserRoles ur
      INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
      WHERE ur.UserId = @userId
      ORDER BY 
        CASE r.Name
          WHEN 'SysAdmin' THEN 1
          WHEN 'TenantAdmin' THEN 2
          WHEN 'Agent' THEN 3
          WHEN 'GroupAdmin' THEN 4
          WHEN 'Member' THEN 5
          ELSE 6
        END
    `);
    
    return result.recordset.map(row => row.Name);
  }

  /**
   * Check if a user has a specific role
   * @param {string} userId - The user's unique identifier
   * @param {string} roleName - The role name to check (e.g., 'SysAdmin', 'Agent')
   * @returns {Promise<boolean>}
   */
  static async userHasRole(userId, roleName) {
    const pool = await getPool();
    const request = pool.request();
    
    request.input('userId', sql.UniqueIdentifier, userId);
    request.input('roleName', sql.NVarChar, roleName);
    
    const result = await request.query(`
      SELECT COUNT(*) as RoleCount
      FROM oe.UserRoles ur
      INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
      WHERE ur.UserId = @userId AND r.Name = @roleName
    `);
    
    return result.recordset[0].RoleCount > 0;
  }

  /**
   * Assign a role to a user
   * @param {string} userId - The user's unique identifier
   * @param {string} roleName - The role name to assign
   * @param {string} createdBy - The user ID of who is assigning the role
   * @param {Transaction} existingTransaction - Optional existing transaction to use (avoids nested transactions)
   * @returns {Promise<{userRoleId: string}>}
   */
  static async assignRoleToUser(userId, roleName, createdBy = null, existingTransaction = null) {
    const useExistingTransaction = existingTransaction !== null;
    const transaction = existingTransaction || (await getPool()).transaction();
    
    try {
      if (!useExistingTransaction) {
        await transaction.begin();
      }
      
      // Get the RoleId for the role name
      const roleRequest = transaction.request();
      roleRequest.input('roleName', sql.NVarChar, roleName);
      
      const roleResult = await roleRequest.query(`
        SELECT RoleId FROM oe.Roles WHERE Name = @roleName
      `);
      
      if (roleResult.recordset.length === 0) {
        if (!useExistingTransaction) {
          await transaction.rollback();
        }
        throw new Error(`Role '${roleName}' not found in oe.Roles table`);
      }
      
      const roleId = roleResult.recordset[0].RoleId;
      
      // Check if user already has this role
      const checkRequest = transaction.request();
      checkRequest.input('userId', sql.UniqueIdentifier, userId);
      checkRequest.input('roleId', sql.UniqueIdentifier, roleId);
      
      const checkResult = await checkRequest.query(`
        SELECT UserRoleId FROM oe.UserRoles 
        WHERE UserId = @userId AND RoleId = @roleId
      `);
      
      if (checkResult.recordset.length > 0) {
        if (!useExistingTransaction) {
          await transaction.commit();
        }
        return { userRoleId: checkResult.recordset[0].UserRoleId, alreadyAssigned: true };
      }
      
      // Assign the role
      const crypto = require('crypto');
      const userRoleId = crypto.randomUUID();
      
      const insertRequest = transaction.request();
      insertRequest.input('userRoleId', sql.UniqueIdentifier, userRoleId);
      insertRequest.input('userId', sql.UniqueIdentifier, userId);
      insertRequest.input('roleId', sql.UniqueIdentifier, roleId);
      insertRequest.input('createdBy', sql.UniqueIdentifier, createdBy);
      
      await insertRequest.query(`
        INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedBy, CreatedDate)
        VALUES (@userRoleId, @userId, @roleId, @createdBy, GETDATE())
      `);
      
      if (!useExistingTransaction) {
        await transaction.commit();
      }
      
      console.log(`✅ Assigned role '${roleName}' to user ${userId}`);
      
      return { userRoleId, alreadyAssigned: false };
    } catch (error) {
      if (!useExistingTransaction) {
        await transaction.rollback();
      }
      console.error('Error assigning role to user:', error);
      throw error;
    }
  }

  /**
   * Remove a role from a user
   * @param {string} userId - The user's unique identifier
   * @param {string} roleName - The role name to remove
   * @returns {Promise<boolean>} True if role was removed, false if user didn't have the role
   */
  static async removeRoleFromUser(userId, roleName) {
    const pool = await getPool();
    const transaction = pool.transaction();
    
    try {
      await transaction.begin();
      
      // Get the RoleId for the role name
      const roleRequest = transaction.request();
      roleRequest.input('roleName', sql.NVarChar, roleName);
      
      const roleResult = await roleRequest.query(`
        SELECT RoleId FROM oe.Roles WHERE Name = @roleName
      `);
      
      if (roleResult.recordset.length === 0) {
        throw new Error(`Role '${roleName}' not found in oe.Roles table`);
      }
      
      const roleId = roleResult.recordset[0].RoleId;
      
      // Remove the role
      const deleteRequest = transaction.request();
      deleteRequest.input('userId', sql.UniqueIdentifier, userId);
      deleteRequest.input('roleId', sql.UniqueIdentifier, roleId);
      
      const result = await deleteRequest.query(`
        DELETE FROM oe.UserRoles 
        WHERE UserId = @userId AND RoleId = @roleId
      `);
      
      await transaction.commit();
      
      const wasRemoved = result.rowsAffected[0] > 0;
      if (wasRemoved) {
        console.log(`✅ Removed role '${roleName}' from user ${userId}`);
      } else {
        console.log(`ℹ️  User ${userId} did not have role '${roleName}'`);
      }
      
      return wasRemoved;
    } catch (error) {
      await transaction.rollback();
      console.error('Error removing role from user:', error);
      throw error;
    }
  }

  /**
   * Get the highest priority role for a user (for backward compatibility)
   * @param {string} userId - The user's unique identifier
   * @returns {Promise<string|null>} The name of the highest priority role, or null
   */
  static async getPrimaryRole(userId) {
    const roles = await this.getUserRoleNames(userId);
    
    if (roles.length === 0) {
      return null;
    }
    
    // Return the first role (already ordered by hierarchy)
    return roles[0];
  }

  /**
   * Get all available roles from oe.Roles table
   * @returns {Promise<Array<{roleId: string, roleName: string, description: string}>>}
   */
  static async getSystemRoles() {
    const pool = await getPool();
    const request = pool.request();
    
    // Get ALL roles from oe.Roles table (not just IsSystemRole = 1)
    const result = await request.query(`
      SELECT RoleId, Name, Description, IsSystemRole
      FROM oe.Roles
      ORDER BY 
        CASE Name
          WHEN 'SysAdmin' THEN 1
          WHEN 'TenantAdmin' THEN 2
          WHEN 'TenantAccounting' THEN 3
          WHEN 'TenantIT' THEN 4
          WHEN 'Agent' THEN 5
          WHEN 'GroupAdmin' THEN 6
          WHEN 'Member' THEN 7
          WHEN 'VendorAdmin' THEN 8
          WHEN 'VendorAgent' THEN 9
          ELSE 10
        END
    `);
    
    return result.recordset.map(role => ({
      roleId: role.RoleId,
      roleName: role.Name,
      description: role.Description,
      isSystemRole: role.IsSystemRole
    }));
  }

  /**
   * Sync a user's roles (replace all roles with new set)
   * @param {string} userId - The user's unique identifier
   * @param {Array<string>} roleNames - Array of role names to assign
   * @param {string} modifiedBy - The user ID of who is modifying the roles
   * @param {Transaction} existingTransaction - Optional existing transaction to use (avoids nested transactions)
   * @returns {Promise<void>}
   */
  static async syncUserRoles(userId, roleNames, modifiedBy = null, existingTransaction = null) {
    const useExistingTransaction = existingTransaction !== null;
    const transaction = existingTransaction || (await getPool()).transaction();
    
    try {
      if (!useExistingTransaction) {
        await transaction.begin();
      }
      
      // Remove all existing roles
      const deleteRequest = transaction.request();
      deleteRequest.input('userId', sql.UniqueIdentifier, userId);
      await deleteRequest.query(`DELETE FROM oe.UserRoles WHERE UserId = @userId`);
      
      // Add new roles
      for (const roleName of roleNames) {
        const roleRequest = transaction.request();
        roleRequest.input('roleName', sql.NVarChar, roleName);
        
        const roleResult = await roleRequest.query(`
          SELECT RoleId FROM oe.Roles WHERE Name = @roleName
        `);
        
        if (roleResult.recordset.length === 0) {
          if (!useExistingTransaction) {
            await transaction.rollback();
          }
          throw new Error(`Role '${roleName}' not found in oe.Roles table`);
        }
        
        const roleId = roleResult.recordset[0].RoleId;
        const crypto = require('crypto');
        const userRoleId = crypto.randomUUID();
        
        const insertRequest = transaction.request();
        insertRequest.input('userRoleId', sql.UniqueIdentifier, userRoleId);
        insertRequest.input('userId', sql.UniqueIdentifier, userId);
        insertRequest.input('roleId', sql.UniqueIdentifier, roleId);
        insertRequest.input('createdBy', sql.UniqueIdentifier, modifiedBy);
        
        await insertRequest.query(`
          INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedBy, CreatedDate)
          VALUES (@userRoleId, @userId, @roleId, @createdBy, GETDATE())
        `);
      }
      
      if (!useExistingTransaction) {
        await transaction.commit();
      }
      
      console.log(`✅ Synced roles for user ${userId}:`, roleNames);
    } catch (error) {
      if (!useExistingTransaction) {
        await transaction.rollback();
      }
      console.error('Error syncing user roles:', error);
      throw error;
    }
  }
}

module.exports = UserRolesService;

