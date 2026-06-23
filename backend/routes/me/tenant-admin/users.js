const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { hashPassword, comparePassword } = require('../../../utils/passwordHash');
const { authorize, getUserRoles } = require('../../../middleware/auth');
const UserRolesService = require('../../../services/shared/user-roles.service');
const UserEmailService = require('../../../services/shared/user-email.service');
const UserManagementService = require('../../../services/shared/user-management.service');
const { tenantIdsMatch } = require('../../../utils/tenantIds');

// GET /check-email-availability - specific route (must be before /:id)
router.get('/check-email-availability', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { email, excludeUserId } = req.query;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Email query parameter is required',
      });
    }

    const result = await UserEmailService.checkEmailAvailable(email, excludeUserId || null);

    res.json({
      success: true,
      data: { available: result.available },
    });
  } catch (error) {
    console.error('❌ Error checking email availability:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while checking email availability',
    });
  }
});

// PUT /:id/email - Change user's email (TenantAdmin can only change users in their tenant)
router.put('/:id/email', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.body;
    const activeTenantId = req.tenantId || req.user.TenantId;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Email is required',
      });
    }

    const pool = await getPool();
    const checkRequest = pool.request();
    checkRequest.input('userId', sql.UniqueIdentifier, id);
    checkRequest.input('tenantId', sql.UniqueIdentifier, activeTenantId);

    const checkResult = await checkRequest.query(`
      SELECT UserId FROM oe.Users
      WHERE UserId = @userId AND TenantId = @tenantId
    `);

    if (checkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found or access denied (user must belong to your tenant)',
      });
    }

    const result = await UserEmailService.updateUserEmail(id, email, req.user.UserId);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.message || 'Failed to update email',
      });
    }

    res.json({
      success: true,
      data: { email: email.trim().toLowerCase() },
      message: 'Email updated successfully',
    });
  } catch (error) {
    console.error('❌ Error updating user email:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating email',
    });
  }
});

// POST Set temporary password (admin provides the password) - must be before other /:id routes
router.post('/:id/set-temporary-password', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  console.log('🔐 [set-temporary-password] Handler hit for userId:', req.params.id);
  try {
    const { id } = req.params;
    const { newPassword } = req.body || {};
    const activeTenantId = req.tenantId || req.user.TenantId;
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters',
      });
    }
    const pool = await getPool();
    const checkRequest = pool.request();
    checkRequest.input('userId', sql.UniqueIdentifier, id);
    checkRequest.input('tenantId', sql.UniqueIdentifier, activeTenantId);
    const checkResult = await checkRequest.query(`
      SELECT UserId, Email FROM oe.Users
      WHERE UserId = @userId
        AND (
          TenantId = @tenantId
          OR (
            ISJSON(AdditionalTenants) = 1
            AND EXISTS (
              SELECT 1
              FROM OPENJSON(AdditionalTenants) AS j
              WHERE TRY_CAST(LTRIM(RTRIM(j.value)) AS UNIQUEIDENTIFIER) = @tenantId
            )
          )
        )
    `);
    if (checkResult.recordset.length === 0) {
      return res.status(403).json({ success: false, message: 'User not found or access denied (user must belong to your tenant)' });
    }
    const hashedPassword = await hashPassword(newPassword);
    if (hashedPassword.length > 255) {
      console.error('❌ [set-temporary-password] Hash too long:', hashedPassword.length);
      return res.status(500).json({ success: false, message: 'Password hash too long for database' });
    }
    const updateRequest = pool.request();
    updateRequest.input('userId', sql.UniqueIdentifier, id);
    updateRequest.input('hashedPassword', sql.NVarChar(255), hashedPassword);
    updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
    await updateRequest.query(`
      UPDATE oe.Users
      SET PasswordHash = @hashedPassword,
          Status = 'Active',
          ResetPasswordToken = NULL,
          ResetPasswordExpiry = NULL,
          ModifiedDate = GETDATE(),
          ModifiedBy = @modifiedBy
      WHERE UserId = @userId
    `);
    // Verify the stored hash works (catches DB truncation or encoding issues)
    const verifyResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, id)
      .query('SELECT PasswordHash FROM oe.Users WHERE UserId = @userId');
    const storedHash = verifyResult.recordset[0]?.PasswordHash;
    const verifyOk = storedHash && (await comparePassword(newPassword, storedHash));
    if (!verifyOk) {
      console.error('❌ [set-temporary-password] Stored hash verification failed for userId:', id, { storedHashLength: storedHash?.length });
      return res.status(500).json({
        success: false,
        message: 'Password was set but verification failed. The database PasswordHash column may be too short (needs at least 60 characters).',
      });
    }
    res.json({ success: true, message: 'Temporary password set successfully' });
  } catch (error) {
    console.error('❌ Error setting temporary password:', error);
    res.status(500).json({ success: false, message: 'Failed to set temporary password' });
  }
});

// GET Tenant Users - Get all users for the current tenant
router.get('/', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { search, roleName, status, sortBy = 'firstName', sortOrder = 'asc' } = req.query;
    const pool = await getPool();
    
    // Build query with optional role filter
    let query = `
      SELECT DISTINCT
        u.UserId,
        u.Email,
        u.FirstName,
        u.LastName,
        u.Status,
        u.TenantId,
        u.AdditionalTenants,
        u.PhoneNumber,
        u.CreatedDate,
        u.ModifiedDate,
        u.LastLoginDate
      FROM oe.Users u
    `;
    
    // Add JOIN to UserRoles if filtering by role
    if (roleName) {
      query += `
      INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId
      INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
      `;
    }
    
    // Primary tenant OR multi-tenant access via AdditionalTenants JSON (same model as requireTenantAccess)
    query += ` WHERE (
      u.TenantId = @tenantId
      OR (
        ISJSON(u.AdditionalTenants) = 1
        AND EXISTS (
          SELECT 1
          FROM OPENJSON(u.AdditionalTenants) AS j
          WHERE TRY_CAST(LTRIM(RTRIM(j.value)) AS UNIQUEIDENTIFIER) = @tenantId
        )
      )
    )`;
    
    const request = pool.request();
    // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
    const activeTenantId = req.tenantId || req.user.TenantId;
    request.input('tenantId', sql.UniqueIdentifier, activeTenantId);
    
    // Add search filter
    if (search) {
      query += ` AND (
        u.FirstName LIKE @search OR 
        u.LastName LIKE @search OR 
        u.Email LIKE @search
      )`;
      request.input('search', sql.NVarChar, `%${search}%`);
    }
    
    // Add role filter (using new UserRoles table)
    if (roleName) {
      query += ' AND r.Name = @roleName';
      request.input('roleName', sql.NVarChar, roleName);
    }
    
    // Add status filter
    if (status) {
      query += ' AND u.Status = @status';
      request.input('status', sql.NVarChar, status);
    }
    
    // Add sorting
    const validSortFields = ['firstName', 'lastName', 'email', 'status', 'createdDate', 'lastLoginDate'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'firstName';
    const sortDirection = sortOrder.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    
    query += ` ORDER BY u.${sortField} ${sortDirection}`;
    
    const result = await request.query(query);
    
    // Transform data for frontend and get roles from UserRoles table
    const users = await Promise.all(result.recordset.map(async (user) => {
      const userRoles = await UserRolesService.getUserRoleNames(user.UserId);
      let additionalTenantIds = [];
      if (user.AdditionalTenants) {
        try {
          const parsed = JSON.parse(user.AdditionalTenants);
          if (Array.isArray(parsed)) {
            additionalTenantIds = parsed.filter(
              (id) => id && String(id).trim() !== '' && String(id) !== '00000000-0000-0000-0000-000000000000'
            );
          }
        } catch (_e) {
          additionalTenantIds = [];
        }
      }
      const otherTenantAccessCount = UserManagementService.countAccessibleTenantsExcept(
        user.TenantId,
        additionalTenantIds,
        activeTenantId
      );
      const isPrimaryForThisOrg = tenantIdsMatch(user.TenantId, activeTenantId);

      return {
        userId: user.UserId,
        email: user.Email,
        firstName: user.FirstName,
        lastName: user.LastName,
        status: user.Status,
        tenantId: user.TenantId,
        phoneNumber: user.PhoneNumber,
        createdDate: user.CreatedDate,
        modifiedDate: user.ModifiedDate,
        lastLoginDate: user.LastLoginDate,
        roles: userRoles,
        otherTenantAccessCount,
        isPrimaryForThisOrg
      };
    }));
    
    res.json({
      success: true,
      data: users
    });
    
  } catch (error) {
    console.error('❌ Error fetching tenant users:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users'
    });
  }
});

// POST Create Tenant User
router.post('/', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phoneNumber,
      sendWelcomeEmail = true
    } = req.body;

    const activeTenantId = req.tenantId || req.user.TenantId;

    // Always create TenantAdmin users from this endpoint
    const roleName = 'TenantAdmin';

    console.log('📝 Creating tenant user:', {
      firstName,
      lastName,
      email,
      role: roleName,
      tenantId: activeTenantId,
      requestedBy: getUserRoles(req.user).join(', ')
    });

    // Validation
    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    const pool = await getPool();

    // Check if email already exists and get user info with roles
    const emailCheckRequest = pool.request();
    emailCheckRequest.input('email', sql.NVarChar, email.trim().toLowerCase());
    const emailCheck = await emailCheckRequest.query(`
      SELECT 
        u.UserId, 
        u.FirstName, 
        u.LastName, 
        u.Email, 
        u.PasswordHash,
        u.Status as UserStatus,
        u.TenantId
      FROM oe.Users u
      WHERE u.Email = @email
    `);
    
    const existingUser = emailCheck.recordset.length > 0 ? emailCheck.recordset[0] : null;
    let isExistingUser = false;
    let userId;

    if (existingUser) {
      console.log('📧 Existing user found:', {
        userId: existingUser.UserId,
        email: existingUser.Email,
        tenantId: existingUser.TenantId,
        hasPassword: !!existingUser.PasswordHash
      });

      // Check if user already has TenantAdmin role — grant access to this org via AdditionalTenants when needed
      const hasTenantAdminRole = await UserRolesService.userHasRole(existingUser.UserId, 'TenantAdmin');

      if (hasTenantAdminRole) {
        const grant = await UserManagementService.ensureTenantAdminAccessToTenantId(
          pool,
          existingUser.UserId,
          activeTenantId,
          req.user.UserId
        );
        if (!grant.ok) {
          return res.status(500).json({
            success: false,
            message: grant.error || 'Failed to grant tenant admin access'
          });
        }

        const baseUrl = await UserManagementService.resolveLinkBaseUrl(req, activeTenantId);
        const allRoles = await UserRolesService.getUserRoleNames(existingUser.UserId);

        if (grant.addedAdditionalTenant) {
          let emailResult = { success: true, skipped: true };
          try {
            emailResult = await UserManagementService.sendTenantAdminAccessGrantedNotification({
              tenantId: activeTenantId,
              recipientEmail: existingUser.Email,
              recipientFirstName: existingUser.FirstName || firstName,
              recipientUserId: existingUser.UserId,
              createdBy: req.user.UserId,
              baseUrl,
              sendWelcomeEmail
            });
          } catch (emailErr) {
            console.error('❌ Failed to queue access granted email:', emailErr);
            emailResult = { error: emailErr.message, success: false };
          }
          return res.json({
            success: true,
            message:
              'Tenant admin access added for this organization. They can sign in with their existing account and switch organizations if needed.',
            data: {
              userId: existingUser.UserId,
              email: existingUser.Email,
              firstName: existingUser.FirstName,
              lastName: existingUser.LastName,
              roles: allRoles,
              crossTenantTenantAdminGranted: true,
              emailResult
            }
          });
        }

        return res.json({
          success: true,
          message: 'This user already has tenant admin access for this organization.',
          data: {
            userId: existingUser.UserId,
            email: existingUser.Email,
            firstName: existingUser.FirstName,
            lastName: existingUser.LastName,
            roles: allRoles,
            alreadyHadTenantAdminAccessForOrg: true
          }
        });
      }

      // Check tenant compatibility - user must belong to the same tenant (or have no tenant)
      if (existingUser.TenantId && existingUser.TenantId.toString() !== activeTenantId.toString()) {
        return res.status(403).json({
          success: false,
          message: 'This user belongs to a different tenant and cannot be added as a tenant admin here.',
          isDifferentTenant: true
        });
      }
      
      // If user has no tenant assigned, we'll update it to the current tenant

      // User exists and can be upgraded to TenantAdmin
      userId = existingUser.UserId;
      isExistingUser = true;
      
      console.log('✅ Using existing user account and adding TenantAdmin role');
    }

    if (!existingUser && (!firstName || !String(firstName).trim() || !lastName || !String(lastName).trim())) {
      return res.status(400).json({
        success: false,
        message: 'First name and last name are required when adding a new user'
      });
    }

    const emailNormalized = email.trim().toLowerCase();
    const firstNameFinal = isExistingUser
      ? (firstName && String(firstName).trim() ? String(firstName).trim() : existingUser.FirstName)
      : String(firstName).trim();
    const lastNameFinal = isExistingUser
      ? (lastName && String(lastName).trim() ? String(lastName).trim() : existingUser.LastName)
      : String(lastName).trim();

    const transaction = pool.transaction();
    await transaction.begin();

    try {
      if (isExistingUser) {
        // Update existing user info with new data (preserve password)
        // Also set TenantId if it's null; activate so they are not blocked by Pending status
        const updateUserRequest = transaction.request();
        updateUserRequest.input('userId', sql.UniqueIdentifier, userId);
        updateUserRequest.input('firstName', sql.NVarChar, firstNameFinal);
        updateUserRequest.input('lastName', sql.NVarChar, lastNameFinal);
        updateUserRequest.input('phoneNumber', sql.NVarChar, phoneNumber || null);
        updateUserRequest.input('tenantId', sql.UniqueIdentifier, activeTenantId);
        updateUserRequest.input('modifiedDate', sql.DateTime2, new Date());
        
        await updateUserRequest.query(`
          UPDATE oe.Users SET
            FirstName = @firstName,
            LastName = @lastName,
            PhoneNumber = @phoneNumber,
            TenantId = ISNULL(TenantId, @tenantId),
            Status = CASE WHEN Status = N'Suspended' THEN Status ELSE N'Active' END,
            ModifiedDate = @modifiedDate
          WHERE UserId = @userId
        `);
        
        console.log('✅ Existing user updated with new info');
        
        // Only generate password reset token if user doesn't have a password
        let passwordResetToken = null;
        let passwordResetExpiry = null;
        
        if (!existingUser.PasswordHash) {
          passwordResetToken = require('crypto').randomUUID();
          passwordResetExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
          
          const updateTokenRequest = transaction.request();
          updateTokenRequest.input('userId', sql.UniqueIdentifier, userId);
          updateTokenRequest.input('passwordResetToken', sql.NVarChar, passwordResetToken);
          updateTokenRequest.input('passwordResetExpiry', sql.DateTime2, passwordResetExpiry);
          
          await updateTokenRequest.query(`
            UPDATE oe.Users SET
              ResetPasswordToken = @passwordResetToken,
              ResetPasswordExpiry = @passwordResetExpiry
            WHERE UserId = @userId
          `);
        } else {
          // User has password - generate token for welcome email anyway (they can reset if needed)
          passwordResetToken = require('crypto').randomUUID();
          passwordResetExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
          
          const updateTokenRequest = transaction.request();
          updateTokenRequest.input('userId', sql.UniqueIdentifier, userId);
          updateTokenRequest.input('passwordResetToken', sql.NVarChar, passwordResetToken);
          updateTokenRequest.input('passwordResetExpiry', sql.DateTime2, passwordResetExpiry);
          
          await updateTokenRequest.query(`
            UPDATE oe.Users SET
              ResetPasswordToken = @passwordResetToken,
              ResetPasswordExpiry = @passwordResetExpiry
            WHERE UserId = @userId
          `);
        }
      } else {
        // Create new user (Active: invitation email is informational; access does not wait on it)
        userId = require('crypto').randomUUID();
        const passwordResetToken = require('crypto').randomUUID();
        const passwordResetExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
        
        const createUserRequest = transaction.request();
        createUserRequest.input('userId', sql.UniqueIdentifier, userId);
        createUserRequest.input('email', sql.NVarChar, emailNormalized);
        createUserRequest.input('firstName', sql.NVarChar, firstNameFinal);
        createUserRequest.input('lastName', sql.NVarChar, lastNameFinal);
        createUserRequest.input('phoneNumber', sql.NVarChar, phoneNumber || null);
        createUserRequest.input('tenantId', sql.UniqueIdentifier, activeTenantId);
        createUserRequest.input('status', sql.NVarChar, 'Active');
        createUserRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
        createUserRequest.input('passwordResetToken', sql.NVarChar, passwordResetToken);
        createUserRequest.input('passwordResetExpiry', sql.DateTime2, passwordResetExpiry);

        const createUserQuery = `
          INSERT INTO oe.Users (
            UserId, Email, FirstName, LastName, PhoneNumber,
            TenantId, Status, CreatedDate, CreatedBy, MfaEnabled,
            ResetPasswordToken, ResetPasswordExpiry
          ) VALUES (
            @userId, @email, @firstName, @lastName, @phoneNumber,
            @tenantId, @status, GETDATE(), @createdBy, 0,
            @passwordResetToken, @passwordResetExpiry
          )
        `;

        await createUserRequest.query(createUserQuery);
        console.log('✅ New user created');
      }

      const roleResult = await UserRolesService.assignRoleToUser(userId, roleName, req.user.UserId, transaction);
      if (roleResult.alreadyAssigned) {
        console.log(`ℹ️ User already has ${roleName} role`);
      } else {
        console.log(`✅ Assigned ${roleName} role to user ${userId}`);
      }

      await transaction.commit();

      // Get user's current status for response
      const userStatusRequest = pool.request();
      userStatusRequest.input('userId', sql.UniqueIdentifier, userId);
      const userStatusResult = await userStatusRequest.query(`
        SELECT Status, ResetPasswordToken, ResetPasswordExpiry 
        FROM oe.Users 
        WHERE UserId = @userId
      `);
      
      const userStatus = userStatusResult.recordset[0].Status;
      const passwordResetToken = userStatusResult.recordset[0].ResetPasswordToken;
      
      // Generate password setup link
      const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
      const passwordSetupLink = passwordResetToken ? `${baseUrl}/setup-password/${passwordResetToken}` : null;
      
      // Console log the link for testing
      if (passwordSetupLink) {
        console.log(`🔗 Password Setup Link for ${emailNormalized}: ${passwordSetupLink}`);
      }

      // Get all user roles
      const userRoles = await UserRolesService.getUserRoleNames(userId);

      if (sendWelcomeEmail) {
        const MessageQueueService = require('../../../services/messageQueue.service');
        try {
          const messageId = await MessageQueueService.sendUserWelcome({
            tenantId: activeTenantId,
            userId: userId,
            userEmail: isExistingUser ? existingUser.Email : emailNormalized,
            firstName: firstNameFinal,
            userType: roleName,
            setupUrl: passwordSetupLink,
            createdBy: req.user.UserId
          });
          console.log(`✅ Queued tenant admin invitation/welcome email for ${emailNormalized}: ${messageId}`);
        } catch (emailError) {
          console.error(`❌ Failed to queue welcome email for ${emailNormalized}:`, emailError);
        }
      }

      res.json({
        success: true,
        message: isExistingUser 
          ? 'TenantAdmin role added to existing user successfully'
          : 'User created successfully',
        data: {
          userId,
          email: isExistingUser ? existingUser.Email : emailNormalized,
          firstName: firstNameFinal,
          lastName: lastNameFinal,
          roles: userRoles,
          status: userStatus,
          passwordSetupLink,
          isExistingUser,
          requiresPasswordConfirmation: isExistingUser && !!existingUser?.PasswordHash
        }
      });

    } catch (error) {
      await transaction.rollback();
      throw error;
    }

  } catch (error) {
    console.error('❌ Error creating tenant user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create user'
    });
  }
});

// PUT Update User Status
router.put('/:id/status', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['Active', 'Inactive', 'Suspended'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be Active, Inactive, or Suspended'
      });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('userId', sql.UniqueIdentifier, id);
    request.input('status', sql.NVarChar, status);
    // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
    const activeTenantId = req.tenantId || req.user.TenantId;
    request.input('tenantId', sql.UniqueIdentifier, activeTenantId);
    request.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

    const query = `
      UPDATE oe.Users 
      SET Status = @status, ModifiedDate = GETDATE(), ModifiedBy = @modifiedBy
      WHERE UserId = @userId AND TenantId = @tenantId
    `;

    const result = await request.query(query);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found or access denied'
      });
    }

    res.json({
      success: true,
      message: 'User status updated successfully'
    });

  } catch (error) {
    console.error('❌ Error updating user status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user status'
    });
  }
});

// POST Reset User Password (generates random temporary password)
router.post('/:id/reset-password', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const activeTenantId = req.tenantId || req.user.TenantId;
    const pool = await getPool();
    
    // Check if user exists and belongs to tenant
    const checkRequest = pool.request();
    checkRequest.input('userId', sql.UniqueIdentifier, id);
    checkRequest.input('tenantId', sql.UniqueIdentifier, activeTenantId);
    
    const checkQuery = `
      SELECT UserId, Email, FirstName, LastName
      FROM oe.Users
      WHERE UserId = @userId
        AND (
          TenantId = @tenantId
          OR (
            ISJSON(AdditionalTenants) = 1
            AND EXISTS (
              SELECT 1
              FROM OPENJSON(AdditionalTenants) AS j
              WHERE TRY_CAST(LTRIM(RTRIM(j.value)) AS UNIQUEIDENTIFIER) = @tenantId
            )
          )
        )
    `;
    
    const checkResult = await checkRequest.query(checkQuery);
    
    if (checkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found or access denied'
      });
    }
    
    const user = checkResult.recordset[0];
    
    const temporaryPassword = Math.random().toString(36).slice(-8);
    const hashedPassword = await hashPassword(temporaryPassword);
    
    // Update password
    const updateRequest = pool.request();
    updateRequest.input('userId', sql.UniqueIdentifier, id);
    updateRequest.input('hashedPassword', sql.NVarChar(255), hashedPassword);
    updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
    
    const updateQuery = `
      UPDATE oe.Users
      SET PasswordHash = @hashedPassword,
          Status = 'Active',
          ResetPasswordToken = NULL,
          ResetPasswordExpiry = NULL,
          ModifiedDate = GETDATE(),
          ModifiedBy = @modifiedBy
      WHERE UserId = @userId
    `;
    
    await updateRequest.query(updateQuery);
    
    res.json({
      success: true,
      message: 'Password reset successfully',
      data: {
        temporaryPassword,
        user: {
          userId: user.UserId,
          email: user.Email,
          firstName: user.FirstName,
          lastName: user.LastName
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Error resetting user password:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reset password'
    });
  }
});

// GET removal preview — options for removing tenant admin from this org
router.get('/:id/removal-preview', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const activeTenantId = req.tenantId || req.user.TenantId;
    const pool = await getPool();

    const preview = await UserManagementService.getTenantAdminRemovalPreview(
      req.user,
      id,
      activeTenantId,
      pool
    );

    res.json({ success: true, data: preview });
  } catch (error) {
    console.error('❌ Error loading tenant admin removal preview:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to load removal options'
    });
  }
});

// GET primary tenant options — for Manage account modal
router.get('/:id/primary-tenant-preview', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const activeTenantId = req.tenantId || req.user.TenantId;
    const pool = await getPool();

    const preview = await UserManagementService.getPrimaryTenantChangePreview(
      req.user,
      id,
      activeTenantId,
      pool
    );

    res.json({ success: true, data: preview });
  } catch (error) {
    console.error('❌ Error loading primary tenant preview:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to load primary tenant options'
    });
  }
});

// PUT — change user's primary tenant (keeps access to all orgs)
router.put('/:id/primary-tenant', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { newPrimaryTenantId } = req.body || {};
    const pool = await getPool();

    const result = await UserManagementService.changePrimaryTenant(
      req.user,
      id,
      newPrimaryTenantId,
      pool
    );

    res.json({
      success: true,
      message: result.message,
      data: result.data
    });
  } catch (error) {
    console.error('❌ Error changing primary tenant:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to change primary tenant'
    });
  }
});

// DELETE — remove access to this tenant (user row stays unless permanently deleted)
router.delete('/:id', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { newPrimaryTenantId, removalMode } = req.body || {};
    const activeTenantId = req.tenantId || req.user.TenantId;
    const pool = await getPool();

    const result = await UserManagementService.removeTenantAdminAccess(
      req.user,
      id,
      activeTenantId,
      { newPrimaryTenantId, removalMode },
      pool
    );

    res.json({
      success: true,
      message: result.message,
      data: result.data
    });
  } catch (error) {
    console.error('❌ Error removing tenant admin:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to remove tenant admin access'
    });
  }
});

// Log at load time so we can confirm this route is registered (helps debug 404s)
const setPwRoute = router.stack.find(l => l.route && l.route.path === '/:id/set-temporary-password');
if (setPwRoute) {
  console.log('✅ Tenant admin users: POST /:id/set-temporary-password registered');
} else {
  console.warn('⚠️ Tenant admin users: POST /:id/set-temporary-password NOT found in stack');
}

module.exports = router;



