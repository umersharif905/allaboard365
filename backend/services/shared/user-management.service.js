const { getPool, sql } = require('../../config/database');
const crypto = require('crypto');
const UserRolesService = require('./user-roles.service');
const { generateAgentCode } = require('../agentCode.service');
const { tenantIdsMatch } = require('../../utils/tenantIds');

/**
 * UNIFIED USER MANAGEMENT SERVICE
 * 
 * Used by multiple endpoints:
 * - /api/me/tenant-admin/users (TenantAdmin role)
 * - /api/me/group-admin/users (GroupAdmin role)
 * 
 * Provides role-based user management with proper tenant/group isolation
 */

class UserManagementService {
  /**
   * Grant access to an organization for a user who already has the TenantAdmin role.
   * Uses Primary TenantId + AdditionalTenants JSON (same model as tenant switching).
   * @returns {{ ok: boolean, alreadyHadAccess?: boolean, addedAdditionalTenant?: boolean, error?: string }}
   */
  static async ensureTenantAdminAccessToTenantId(pool, userId, targetTenantId, modifiedByUserId) {
    const row = await pool
      .request()
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`SELECT TenantId, AdditionalTenants FROM oe.Users WHERE UserId = @userId`);

    if (row.recordset.length === 0) {
      return { ok: false, error: 'User not found' };
    }

    const { TenantId, AdditionalTenants } = row.recordset[0];
    const norm = (g) =>
      String(g || '')
        .replace(/[{}]/gi, '')
        .toLowerCase();
    const targetNorm = norm(targetTenantId);
    const primaryNorm = norm(TenantId);

    if (primaryNorm === targetNorm) {
      return { ok: true, alreadyHadAccess: true, addedAdditionalTenant: false };
    }

    let list = [];
    if (AdditionalTenants) {
      try {
        const parsed = JSON.parse(AdditionalTenants);
        if (Array.isArray(parsed)) {
          list = parsed;
        }
      } catch (_e) {
        list = [];
      }
    }

    if (list.some((id) => norm(id) === targetNorm)) {
      return { ok: true, alreadyHadAccess: true, addedAdditionalTenant: false };
    }

    list.push(targetTenantId);

    await pool
      .request()
      .input('userId', sql.UniqueIdentifier, userId)
      .input('additional', sql.NVarChar(sql.MAX), JSON.stringify(list))
      .input('modifiedBy', sql.UniqueIdentifier, modifiedByUserId)
      .query(`
        UPDATE oe.Users
        SET AdditionalTenants = @additional,
            ModifiedDate = GETDATE(),
            ModifiedBy = @modifiedBy
        WHERE UserId = @userId
      `);

    return { ok: true, alreadyHadAccess: false, addedAdditionalTenant: true };
  }

  /**
   * Email: existing credentials work; use tenant portal / tenant switcher after login.
   */
  static async sendTenantAdminAccessGrantedNotification({
    tenantId,
    recipientEmail,
    recipientFirstName,
    recipientUserId,
    createdBy,
    baseUrl,
    sendWelcomeEmail
  }) {
    if (!sendWelcomeEmail) {
      return { success: true, skipped: true };
    }

    const pool = await getPool();
    const MessageQueueService = require('../messageQueue.service');

    const tenantNameResult = await pool
      .request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`SELECT Name FROM oe.Tenants WHERE TenantId = @tenantId`);
    const tenantName = tenantNameResult.recordset[0]?.Name;

    const loginUrl = `${String(baseUrl).replace(/\/+$/, '')}/login`;
    const htmlContent = `
            <h2>Tenant Admin Access Granted</h2>
            <p>Hi ${recipientFirstName || 'there'},</p>
            <p>You now have access as a <strong>Tenant Admin</strong>${tenantName ? ` for <strong>${tenantName}</strong>` : ''}.</p>
            <p>You can log in using your existing credentials and open the Tenant Admin portal from your dashboard (use the tenant switcher if you manage multiple organizations).</p>
            <p style="margin: 24px 0;">
              <a href="${loginUrl}" style="background-color:#2563eb;color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px;display:inline-block;">
                Sign in
              </a>
            </p>
            <p>If the button doesn’t work, copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color:#666; background:#f9fafb; padding:10px; border-radius:4px;">${loginUrl}</p>
          `;
    const subject = `You now have Tenant Admin access${tenantName ? ` - ${tenantName}` : ''}`;

    const messageId = await MessageQueueService.queueEmail({
      tenantId,
      toEmail: recipientEmail,
      toName: recipientFirstName,
      subject,
      htmlContent,
      messageType: 'Email',
      createdBy,
      recipientId: recipientUserId
    });

    return { messageId, success: true };
  }

  static async resolveLinkBaseUrl(req, tenantId) {
    const DEFAULT_APP_BASE_URL = 'https://app.allaboard365.com';

    const normalizeBaseUrl = (url) => String(url || '').replace(/\/+$/, '');

    const getTenantCustomDomain = async () => {
      try {
        const pool = await getPool();
        const tenantResult = await pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .query(`SELECT CustomDomain, AdvancedSettings FROM oe.Tenants WHERE TenantId = @tenantId`);

        if (tenantResult.recordset.length === 0) return null;
        const tenant = tenantResult.recordset[0];
        let advancedSettings = {};
        try {
          advancedSettings = tenant.AdvancedSettings ? JSON.parse(tenant.AdvancedSettings) : {};
        } catch (_e) {
          advancedSettings = {};
        }
        return tenant.CustomDomain || advancedSettings?.domain?.customDomain || null;
      } catch (_e) {
        return null;
      }
    };

    const customDomain = await getTenantCustomDomain();

    const allowedHosts = new Set(['localhost', '127.0.0.1', 'app.allaboard365.com']);
    if (customDomain && String(customDomain).trim().length > 0) {
      allowedHosts.add(String(customDomain).trim());
    }

    const validate = (candidate) => {
      if (!candidate) return null;
      try {
        const u = new URL(candidate);
        if (!allowedHosts.has(u.hostname)) return null;
        if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
          if (!['http:', 'https:'].includes(u.protocol)) return null;
        } else {
          if (u.protocol !== 'https:') return null;
        }
        return normalizeBaseUrl(u.origin);
      } catch (_e) {
        return null;
      }
    };

    const requested = req?.body?.linkBaseUrl;
    const origin = req ? req.get('origin') : null;
    const fallback = req ? `${req.protocol}://${req.get('host')}` : null;

    return (
      validate(requested) ||
      validate(origin) ||
      validate(fallback) ||
      (customDomain ? `https://${String(customDomain).trim()}` : null) ||
      DEFAULT_APP_BASE_URL
    );
  }

  /**
   * Get users based on current role and context
   * @param {Object} user - Current authenticated user
   * @param {Object} filters - Search and filter options
   * @returns {Promise<Object>} Users data with pagination
   */
  static async getUsers(user, filters = {}) {
    const pool = await getPool();
    const {
      search = '',
      userType = '',
      status = '',
      sortBy = 'FirstName',
      sortOrder = 'ASC',
      page = 1,
      limit = 50
    } = filters;

    let query, baseQuery;
    const request = pool.request();

    // Role-based query construction
    console.log('🔍 User object in getUsers:', {
      userId: user.UserId,
      currentRole: user.currentRole,
      roles: user.roles,
      tenantId: user.TenantId
    });

    if (user.currentRole === 'TenantAdmin') {
      baseQuery = `
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
          u.LastLoginDate,
          u.ResetPasswordToken,
          u.ResetPasswordExpiry,
          CASE 
            WHEN u.PasswordHash IS NULL THEN 'Pending'
            WHEN u.ResetPasswordExpiry < GETDATE() THEN 'Expired'
            ELSE 'Active'
          END as AccountStatus
        FROM oe.Users u
        INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId
        INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
        WHERE (
          u.TenantId = @tenantId
          OR (
            ISJSON(u.AdditionalTenants) = 1
            AND EXISTS (
              SELECT 1
              FROM OPENJSON(u.AdditionalTenants) AS j
              WHERE TRY_CAST(LTRIM(RTRIM(j.value)) AS UNIQUEIDENTIFIER) = @tenantId
            )
          )
        )
          AND r.Name = 'TenantAdmin'
      `;
      request.input('tenantId', sql.UniqueIdentifier, user.TenantId);
    } else if (user.currentRole === 'GroupAdmin') {
      // Get group ID for GroupAdmin
      const groupId = await this.getGroupIdForUser(user.UserId, pool);
      if (!groupId) {
        throw new Error('No active group found for this admin');
      }

      baseQuery = `
        SELECT DISTINCT
          u.UserId,
          u.Email,
          u.FirstName,
          u.LastName,
          u.Status,
          u.TenantId,
          u.PhoneNumber,
          u.CreatedDate,
          u.ModifiedDate,
          u.LastLoginDate,
          u.ResetPasswordToken,
          u.ResetPasswordExpiry,
          CASE 
            WHEN u.PasswordHash IS NULL THEN 'Pending'
            WHEN u.ResetPasswordExpiry < GETDATE() THEN 'Expired'
            ELSE 'Active'
          END as AccountStatus
        FROM oe.Users u
        INNER JOIN oe.Members m ON u.UserId = m.UserId
        WHERE m.GroupId = @groupId
      `;
      request.input('groupId', sql.UniqueIdentifier, groupId);
    } else {
      throw new Error('Unauthorized role for user management');
    }

    // Add search filter
    if (search) {
      baseQuery += ` AND (
        u.FirstName LIKE @search OR 
        u.LastName LIKE @search OR 
        u.Email LIKE @search
      )`;
      request.input('search', sql.NVarChar, `%${search}%`);
    }

    // Add role filter (if userType parameter provided)
    if (userType) {
      // Add JOIN to UserRoles if not already joined (for role filtering)
      if (!baseQuery.includes('oe.UserRoles')) {
        baseQuery += ` 
          AND EXISTS (
            SELECT 1 FROM oe.UserRoles ur2
            INNER JOIN oe.Roles r2 ON ur2.RoleId = r2.RoleId
            WHERE ur2.UserId = u.UserId AND r2.Name = @roleName
          )`;
      } else {
        // UserRoles already joined, just filter by role name
        baseQuery += ' AND r.Name = @roleName';
      }
      request.input('roleName', sql.NVarChar, userType);
    }

    // Add status filter
    if (status) {
      baseQuery += ' AND u.Status = @status';
      request.input('status', sql.NVarChar, status);
    }

    // Add sorting
    const validSortFields = ['FirstName', 'LastName', 'Email', 'UserType', 'Status', 'CreatedDate', 'LastLoginDate'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'FirstName';
    const sortDirection = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    
    // Add pagination
    const offset = (page - 1) * limit;
    
    // Add ORDER BY and pagination to the base query
    baseQuery += ` ORDER BY u.${sortField} ${sortDirection} OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
    
    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, limit);

    const result = await request.query(baseQuery);

    // Get total count for pagination (remove ORDER BY and pagination for count)
    const countQuery = baseQuery
      .replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(*) as Total FROM')
      .replace(/ORDER BY[\s\S]*$/, '');
    const countRequest = pool.request();
    
    // Copy all inputs except offset and limit
    for (const [key, value] of Object.entries(request.parameters)) {
      if (key !== 'offset' && key !== 'limit') {
        countRequest.input(key, value.type, value.value);
      }
    }
    
    const countResult = await countRequest.query(countQuery);
    const total = countResult.recordset[0].Total;

    // Transform data for frontend and get roles from UserRoles table
    const users = await Promise.all(result.recordset.map(async (user) => {
      const userRoles = await UserRolesService.getUserRoleNames(user.UserId);
      let otherTenantAccessCount = 0;
      if (user.AdditionalTenants) {
        try {
          const parsed = JSON.parse(user.AdditionalTenants);
          if (Array.isArray(parsed)) {
            otherTenantAccessCount = parsed.filter(
              (tid) => tid && String(tid).trim() !== '' && String(tid) !== '00000000-0000-0000-0000-000000000000'
            ).length;
          }
        } catch (_e) {
          otherTenantAccessCount = 0;
        }
      }

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
        accountStatus: user.AccountStatus,
        hasPasswordSetupLink: !!user.ResetPasswordToken && user.ResetPasswordExpiry > new Date(),
        passwordSetupExpiry: user.ResetPasswordExpiry,
        passwordSetupToken: user.ResetPasswordToken,
        otherTenantAccessCount
      };
    }));

    return {
      users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(total),
        pages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Create a new user with password setup link
   * @param {Object} user - Current authenticated user
   * @param {Object} userData - New user data
   * @param {Object} req - Express request object (for extracting baseUrl)
   * @returns {Promise<Object>} Created user with setup link
   */
  static async createUser(user, userData, req) {
    /** Org being administered (tenant switcher / x-current-tenant-id), not only JWT primary tenant */
    const targetTenantId = req?.tenantId || user.TenantId;
    const baseUrl = await this.resolveLinkBaseUrl(req, targetTenantId);
    
    console.log('🔍 DEBUG: URL Construction:', {
      origin: req ? req.get('origin') : null,
      fallback: req ? `${req.protocol}://${req.get('host')}` : null,
      baseUrl: baseUrl,
      allHeaders: req ? {
        origin: req.get('origin'),
        referer: req.get('referer'),
        host: req.get('host')
      } : 'no req'
    });
    const {
      firstName,
      lastName,
      email,
      phoneNumber,
      roles,
      userType,
      sendWelcomeEmail = true
    } = userData;

    // Handle both old roles array format and new userType string format
    const userRoles = roles || [userType];

    // Validate roles based on current role BEFORE starting transaction
    const validRoles = this.getValidUserTypes(user.currentRole);
    if (!validRoles.includes(userRoles[0])) {
      throw new Error(`Invalid role. Must be one of: ${validRoles.join(', ')}`);
    }

    const pool = await getPool();

    // If the email already exists and we're granting GroupAdmin access, upgrade the existing user instead of failing.
    const existingUserResult = await pool.request()
      .input('email', sql.NVarChar, email)
      .query(`
        SELECT TOP 1
          UserId,
          Email,
          FirstName,
          LastName,
          TenantId,
          Status,
          PasswordHash
        FROM oe.Users
        WHERE Email = @email
      `);

    if (existingUserResult.recordset.length > 0) {
      const existingUser = existingUserResult.recordset[0];

      if (userRoles[0] === 'TenantAdmin') {
        const alreadyTenantAdmin = await UserRolesService.userHasRole(existingUser.UserId, 'TenantAdmin');
        if (alreadyTenantAdmin) {
          const grant = await UserManagementService.ensureTenantAdminAccessToTenantId(
            pool,
            existingUser.UserId,
            targetTenantId,
            user.UserId
          );
          if (!grant.ok) {
            throw new Error(grant.error || 'Failed to grant tenant admin access');
          }

          const allRoles = await UserRolesService.getUserRoleNames(existingUser.UserId);

          if (grant.addedAdditionalTenant) {
            let emailResult = { success: true, skipped: true };
            try {
              emailResult = await UserManagementService.sendTenantAdminAccessGrantedNotification({
                tenantId: targetTenantId,
                recipientEmail: existingUser.Email,
                recipientFirstName: existingUser.FirstName || firstName,
                recipientUserId: existingUser.UserId,
                createdBy: user.UserId,
                baseUrl,
                sendWelcomeEmail
              });
            } catch (emailErr) {
              console.error(`❌ Failed to queue access granted email for ${email}:`, emailErr);
              emailResult = { error: emailErr.message, success: false };
            }

            return {
              userId: existingUser.UserId,
              email: existingUser.Email,
              firstName: existingUser.FirstName || firstName,
              lastName: existingUser.LastName || lastName,
              roles: allRoles,
              status: existingUser.Status,
              isExistingUser: true,
              existingAccountMatched: true,
              requiresPasswordConfirmation: !!existingUser.PasswordHash,
              crossTenantTenantAdminGranted: true,
              emailResult
            };
          }

          return {
            userId: existingUser.UserId,
            email: existingUser.Email,
            firstName: existingUser.FirstName || firstName,
            lastName: existingUser.LastName || lastName,
            roles: allRoles,
            status: existingUser.Status,
            isExistingUser: true,
            existingAccountMatched: true,
            requiresPasswordConfirmation: !!existingUser.PasswordHash,
            alreadyHadTenantAdminAccessForOrg: true,
            emailResult: { success: true, skipped: true }
          };
        }

        const roleAssignResult = await UserRolesService.assignRoleToUser(existingUser.UserId, 'TenantAdmin', user.UserId);

        const grantNewTa = await UserManagementService.ensureTenantAdminAccessToTenantId(
          pool,
          existingUser.UserId,
          targetTenantId,
          user.UserId
        );
        if (!grantNewTa.ok) {
          throw new Error(grantNewTa.error || 'Failed to grant tenant admin access to this organization');
        }

        const passwordSetupRequired = existingUser.PasswordHash == null;
        let passwordSetupLink = null;
        let passwordResetExpiry = null;
        let emailResult = { success: true, skipped: true };

        if (passwordSetupRequired) {
          const passwordResetToken = crypto.randomUUID();
          passwordResetExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

          await pool.request()
            .input('userId', sql.UniqueIdentifier, existingUser.UserId)
            .input('passwordResetToken', sql.NVarChar, passwordResetToken)
            .input('passwordResetExpiry', sql.DateTime2, passwordResetExpiry)
            .input('modifiedBy', sql.UniqueIdentifier, user.UserId)
            .query(`
              UPDATE oe.Users
              SET ResetPasswordToken = @passwordResetToken,
                  ResetPasswordExpiry = @passwordResetExpiry,
                  ModifiedDate = GETDATE(),
                  ModifiedBy = @modifiedBy
              WHERE UserId = @userId
            `);

          passwordSetupLink = `${baseUrl}/setup-password/${passwordResetToken}`;

          if (sendWelcomeEmail) {
            const MessageQueueService = require('../messageQueue.service');
            try {
              const messageId = await MessageQueueService.sendUserWelcome({
                tenantId: targetTenantId,
                userId: existingUser.UserId,
                userEmail: existingUser.Email,
                firstName: existingUser.FirstName || firstName,
                userType: 'TenantAdmin',
                setupUrl: passwordSetupLink,
                createdBy: user.UserId
              });
              emailResult = { messageId, success: true };
            } catch (error) {
              console.error(`❌ Failed to queue welcome email for ${email}:`, error);
              emailResult = { error: error.message, success: false };
            }
          }
        }

        if (!passwordSetupRequired && sendWelcomeEmail && !roleAssignResult?.alreadyAssigned) {
          try {
            const MessageQueueService = require('../messageQueue.service');

            const tenantNameResult = await pool.request()
              .input('tenantId', sql.UniqueIdentifier, targetTenantId)
              .query(`SELECT Name FROM oe.Tenants WHERE TenantId = @tenantId`);
            const tenantName = tenantNameResult.recordset[0]?.Name;

            const loginUrl = `${String(baseUrl).replace(/\/+$/, '')}/login`;
            const htmlContent = `
            <h2>Tenant Admin Access Granted</h2>
            <p>Hi ${existingUser.FirstName || firstName || 'there'},</p>
            <p>You now have access as a <strong>Tenant Admin</strong>${tenantName ? ` for <strong>${tenantName}</strong>` : ''}.</p>
            <p>You can log in using your existing credentials and open the Tenant Admin portal from your dashboard.</p>
            <p style="margin: 24px 0;">
              <a href="${loginUrl}" style="background-color:#2563eb;color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px;display:inline-block;">
                Sign in
              </a>
            </p>
            <p>If the button doesn’t work, copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color:#666; background:#f9fafb; padding:10px; border-radius:4px;">${loginUrl}</p>
          `;
            const subject = `You now have Tenant Admin access${tenantName ? ` - ${tenantName}` : ''}`;

            const messageId = await MessageQueueService.queueEmail({
              tenantId: targetTenantId,
              toEmail: existingUser.Email,
              toName: existingUser.FirstName || firstName,
              subject,
              htmlContent,
              messageType: 'Email',
              createdBy: user.UserId,
              recipientId: existingUser.UserId
            });

            emailResult = { messageId, success: true };
          } catch (error) {
            console.error(`❌ Failed to queue access granted email for ${email}:`, error);
            emailResult = { error: error.message, success: false };
          }
        }

        return {
          userId: existingUser.UserId,
          email: existingUser.Email,
          firstName: existingUser.FirstName || firstName,
          lastName: existingUser.LastName || lastName,
          roles: ['TenantAdmin'],
          status: existingUser.Status,
          isExistingUser: true,
          existingAccountMatched: true,
          requiresPasswordConfirmation: !!existingUser.PasswordHash,
          roleAlreadyAssigned: !!roleAssignResult?.alreadyAssigned,
          crossTenantTenantAdminGranted: !!grantNewTa.addedAdditionalTenant,
          passwordSetupRequired,
          passwordSetupLink,
          passwordSetupExpiry: passwordResetExpiry,
          emailResult
        };
      }

      // Only allow this upgrade behavior for GroupAdmin creation
      if (userRoles[0] !== 'GroupAdmin') {
        throw new Error('Email already exists');
      }

      // Tenant safety check
      if (String(existingUser.TenantId).toLowerCase() !== String(user.TenantId).toLowerCase()) {
        const err = new Error('Email already exists in a different tenant');
        err.isDifferentTenant = true;
        throw err;
      }

      // Link to the same group as the creator GroupAdmin
      const groupId = await this.getGroupIdForUser(user.UserId, pool);
      if (!groupId) {
        throw new Error('No active group found for this admin');
      }

      // Must be an active member of this group to promote. Users may belong to multiple groups;
      // other memberships must not block granting Group Admin here.
      const existingMemberships = await pool.request()
        .input('userId', sql.UniqueIdentifier, existingUser.UserId)
        .query(`
          SELECT DISTINCT GroupId
          FROM oe.Members
          WHERE UserId = @userId AND Status = 'Active'
        `);
      const inTargetGroup = existingMemberships.recordset.some(
        (r) => String(r.GroupId).toLowerCase() === String(groupId).toLowerCase()
      );
      if (existingMemberships.recordset.length > 0 && !inTargetGroup) {
        throw new Error(
          'This email is tied to another group but is not an active member of this group. Add them to this group first.'
        );
      }

      // Disallow if already a GroupAdmin for this group
      const alreadyGroupAdminForGroup = await pool.request()
        .input('userId', sql.UniqueIdentifier, existingUser.UserId)
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`
          SELECT TOP 1 u.UserId
          FROM oe.Users u
          INNER JOIN oe.Members m ON u.UserId = m.UserId
          INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId
          INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
          WHERE u.UserId = @userId AND m.GroupId = @groupId AND r.Name = 'GroupAdmin'
        `);
      if (alreadyGroupAdminForGroup.recordset.length > 0) {
        throw new Error('This email is already a Group Admin for this group.');
      }

      // Ensure member record exists for this group
      const memberCheck = await pool.request()
        .input('userId', sql.UniqueIdentifier, existingUser.UserId)
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`
          SELECT TOP 1 MemberId, Status
          FROM oe.Members
          WHERE UserId = @userId AND GroupId = @groupId
        `);

      if (memberCheck.recordset.length === 0) {
        const memberId = crypto.randomUUID();
        await pool.request()
          .input('memberId', sql.UniqueIdentifier, memberId)
          .input('userId', sql.UniqueIdentifier, existingUser.UserId)
          .input('groupId', sql.UniqueIdentifier, groupId)
          .input('relationshipType', sql.NVarChar, 'P')
          .input('status', sql.NVarChar, 'Active')
          .input('createdBy', sql.UniqueIdentifier, user.UserId)
          .query(`
            INSERT INTO oe.Members (
              MemberId, UserId, GroupId, RelationshipType, Status, CreatedDate, CreatedBy
            ) VALUES (
              @memberId, @userId, @groupId, @relationshipType, @status, GETDATE(), @createdBy
            )
          `);
      } else if (memberCheck.recordset[0].Status !== 'Active') {
        await pool.request()
          .input('userId', sql.UniqueIdentifier, existingUser.UserId)
          .input('groupId', sql.UniqueIdentifier, groupId)
          .input('modifiedBy', sql.UniqueIdentifier, user.UserId)
          .query(`
            UPDATE oe.Members
            SET Status = 'Active',
                ModifiedDate = GETDATE(),
                ModifiedBy = @modifiedBy
            WHERE UserId = @userId AND GroupId = @groupId
          `);
      }

      const roleAssignResult = await UserRolesService.assignRoleToUser(existingUser.UserId, 'GroupAdmin', user.UserId);

      const passwordSetupRequired = existingUser.PasswordHash == null;
      let passwordSetupLink = null;
      let passwordResetExpiry = null;
      let emailResult = { success: true, skipped: true };

      if (passwordSetupRequired) {
        const passwordResetToken = crypto.randomUUID();
        passwordResetExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        await pool.request()
          .input('userId', sql.UniqueIdentifier, existingUser.UserId)
          .input('passwordResetToken', sql.NVarChar, passwordResetToken)
          .input('passwordResetExpiry', sql.DateTime2, passwordResetExpiry)
          .input('modifiedBy', sql.UniqueIdentifier, user.UserId)
          .query(`
            UPDATE oe.Users
            SET ResetPasswordToken = @passwordResetToken,
                ResetPasswordExpiry = @passwordResetExpiry,
                ModifiedDate = GETDATE(),
                ModifiedBy = @modifiedBy
            WHERE UserId = @userId
          `);

        passwordSetupLink = `${baseUrl}/setup-password/${passwordResetToken}`;

        if (sendWelcomeEmail) {
          const MessageQueueService = require('../messageQueue.service');
          try {
            const messageId = await MessageQueueService.sendUserWelcome({
              tenantId: user.TenantId,
              userId: existingUser.UserId,
              userEmail: existingUser.Email,
              firstName: existingUser.FirstName || firstName,
              userType: 'GroupAdmin',
              setupUrl: passwordSetupLink,
              createdBy: user.UserId
            });
            emailResult = { messageId, success: true };
          } catch (error) {
            console.error(`❌ Failed to queue welcome email for ${email}:`, error);
            emailResult = { error: error.message, success: false };
          }
        }
      }

      // If the user already has a password and is receiving GroupAdmin access for the first time,
      // send an informational email (no setup link needed).
      if (!passwordSetupRequired && sendWelcomeEmail && !roleAssignResult?.alreadyAssigned) {
        try {
          const MessageQueueService = require('../messageQueue.service');

          const groupNameResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(`SELECT Name FROM oe.Groups WHERE GroupId = @groupId`);
          const groupName = groupNameResult.recordset[0]?.Name;

          const loginUrl = `${String(baseUrl).replace(/\/+$/, '')}/login`;
          const htmlContent = `
            <h2>Group Admin Access Granted</h2>
            <p>Hi ${existingUser.FirstName || firstName || 'there'},</p>
            <p>You now have access as a <strong>Group Admin</strong>${groupName ? ` for <strong>${groupName}</strong>` : ''}.</p>
            <p>You can log in using your existing credentials and navigate to the Group Admin portal from your dashboard.</p>
            <p style="margin: 24px 0;">
              <a href="${loginUrl}" style="background-color:#2563eb;color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px;display:inline-block;">
                Sign in
              </a>
            </p>
            <p>If the button doesn’t work, copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color:#666; background:#f9fafb; padding:10px; border-radius:4px;">${loginUrl}</p>
          `;
          const subject = `You now have Group Admin access${groupName ? ` - ${groupName}` : ''}`;

          const messageId = await MessageQueueService.queueEmail({
            tenantId: user.TenantId,
            toEmail: existingUser.Email,
            toName: existingUser.FirstName || firstName,
            subject,
            htmlContent,
            messageType: 'Email',
            createdBy: user.UserId,
            recipientId: existingUser.UserId
          });

          emailResult = { messageId, success: true };
        } catch (error) {
          console.error(`❌ Failed to queue access granted email for ${email}:`, error);
          emailResult = { error: error.message, success: false };
        }
      }

      return {
        userId: existingUser.UserId,
        email: existingUser.Email,
        firstName: existingUser.FirstName || firstName,
        lastName: existingUser.LastName || lastName,
        roles: ['GroupAdmin'],
        status: existingUser.Status,
        existingUser: true,
        roleAlreadyAssigned: !!roleAssignResult?.alreadyAssigned,
        passwordSetupRequired,
        passwordSetupLink,
        passwordSetupExpiry: passwordResetExpiry,
        emailResult
      };
    }

    const transaction = pool.transaction();
    let transactionStarted = false;

    try {
      console.log('🔄 Starting transaction for user creation...');
      await transaction.begin();
      transactionStarted = true;
      console.log('✅ Transaction started successfully');

      // Check if email already exists (defensive; should have been handled above)
      const emailCheckRequest = transaction.request();
      emailCheckRequest.input('email', sql.NVarChar, email);
      const emailCheck = await emailCheckRequest.query('SELECT UserId FROM oe.Users WHERE Email = @email');
      if (emailCheck.recordset.length > 0) {
        await transaction.rollback();
        throw new Error('Email already exists');
      }

      // Create user
      const userId = crypto.randomUUID();
      const passwordResetToken = crypto.randomUUID();
      const passwordResetExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

      const createUserRequest = transaction.request();
      createUserRequest.input('userId', sql.UniqueIdentifier, userId);
      createUserRequest.input('email', sql.NVarChar, email);
      createUserRequest.input('firstName', sql.NVarChar, firstName);
      createUserRequest.input('lastName', sql.NVarChar, lastName);
      createUserRequest.input('phoneNumber', sql.NVarChar, phoneNumber || null);
      createUserRequest.input('tenantId', sql.UniqueIdentifier, targetTenantId);
      // Active: same as group-user-management; account still shows "Pending setup" in UI until PasswordHash is set
      createUserRequest.input('status', sql.NVarChar, 'Active');
      createUserRequest.input('createdBy', sql.UniqueIdentifier, user.UserId);
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

      // Create role-specific records
      if (userRoles[0] === 'Agent') {
        await this.createAgentRecord(transaction, userId, user);
      } else if (userRoles[0] === 'GroupAdmin') {
        const groupId = await this.getGroupIdForUser(user.UserId, pool);
        if (groupId) {
          await this.createMemberRecord(transaction, userId, groupId, user);
        }
      }

      await transaction.commit();

      // Assign roles using UserRolesService (outside transaction to avoid deadlock)
      for (const roleName of userRoles) {
        await UserRolesService.assignRoleToUser(userId, roleName, user.UserId);
      }

      // Generate password setup link
      const passwordSetupLink = `${baseUrl}/setup-password/${passwordResetToken}`;

      // Log the password setup link for manual distribution
      console.log(`🔗 Password Setup Link for ${email}: ${passwordSetupLink}`);
      console.log(`⏰ Link expires: ${passwordResetExpiry.toISOString()}`);

      // Send welcome email if requested — if queue fails, remove the new user so they are not stuck without an invite
      let emailResult = null;
      if (sendWelcomeEmail) {
        const MessageQueueService = require('../messageQueue.service');
        try {
          const messageId = await MessageQueueService.sendUserWelcome({
            tenantId: targetTenantId,
            userId: userId,
            userEmail: email,
            firstName: firstName,
            userType: userRoles[0],
            setupUrl: passwordSetupLink,
            createdBy: user.UserId
          });
          console.log(`✅ Queued welcome email for ${email}: ${messageId}`);
          emailResult = { messageId, success: true };
        } catch (error) {
          console.error(`❌ Failed to queue welcome email for ${email}:`, error);
          emailResult = { error: error.message, success: false };
        }
      }

      if (sendWelcomeEmail && emailResult && emailResult.success === false) {
        try {
          await UserManagementService.deleteUser(user, userId, pool);
          console.log(`🗑️ Removed user ${userId} after welcome email queue failure`);
        } catch (delErr) {
          console.error('❌ Failed to remove user after welcome email queue failure:', delErr);
        }
        throw new Error(
          emailResult.error || 'Failed to queue welcome email. No user account was kept; try again.'
        );
      }

      return {
        userId,
        email,
        firstName,
        lastName,
        roles,
        status: 'Active',
        passwordSetupLink,
        passwordSetupExpiry: passwordResetExpiry,
        emailResult
      };

    } catch (error) {
      console.error('❌ Error in createUser, transactionStarted:', transactionStarted);
      console.error('❌ Error details:', error);
      if (transactionStarted) {
        try {
          await transaction.rollback();
          console.log('✅ Transaction rolled back successfully');
        } catch (rollbackError) {
          console.error('❌ Rollback failed:', rollbackError);
        }
      }
      throw error;
    }
  }

  /**
   * Resend password setup link
   * @param {Object} user - Current authenticated user
   * @param {string} userId - User ID to resend link for
   * @param {Object} req - Express request object (for extracting baseUrl)
   * @returns {Promise<Object>} New setup link
   */
  static async resendPasswordSetupLink(user, userId, req) {
    const baseUrl = await this.resolveLinkBaseUrl(req, user.TenantId);
    const pool = await getPool();
    
    // Verify user exists and belongs to current user's context
    const userExists = await this.verifyUserAccess(user, userId, pool);
    if (!userExists) {
      throw new Error('User not found or access denied');
    }

    // Fetch user details for email
    const userDetailsRequest = pool.request();
    userDetailsRequest.input('userId', sql.UniqueIdentifier, userId);
    const userDetailsResult = await userDetailsRequest.query(`
      SELECT Email, FirstName, LastName FROM oe.Users WHERE UserId = @userId
    `);
    
    if (userDetailsResult.recordset.length === 0) {
      throw new Error('User not found');
    }
    
    const userDetails = userDetailsResult.recordset[0];

    // Generate new token and expiry
    const passwordResetToken = crypto.randomUUID();
    const passwordResetExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const updateRequest = pool.request();
    updateRequest.input('userId', sql.UniqueIdentifier, userId);
    updateRequest.input('passwordResetToken', sql.NVarChar, passwordResetToken);
    updateRequest.input('passwordResetExpiry', sql.DateTime2, passwordResetExpiry);
    updateRequest.input('modifiedBy', sql.UniqueIdentifier, user.UserId);

    const updateQuery = `
      UPDATE oe.Users 
      SET ResetPasswordToken = @passwordResetToken, 
          ResetPasswordExpiry = @passwordResetExpiry,
          ModifiedDate = GETDATE(),
          ModifiedBy = @modifiedBy
      WHERE UserId = @userId
    `;

    await updateRequest.query(updateQuery);

    const passwordSetupLink = `${baseUrl}/setup-password/${passwordResetToken}`;

    // Log the new password setup link for manual distribution
    console.log(`🔗 New Password Setup Link for ${userDetails.Email}: ${passwordSetupLink}`);
    console.log(`⏰ Link expires: ${passwordResetExpiry.toISOString()}`);

    // Send welcome email with the new link
    let emailResult = null;
    try {
      const MessageQueueService = require('../messageQueue.service');
      // Get user role to determine userType for email
      const UserRolesService = require('../userRoles.service');
      const userRoles = await UserRolesService.getUserRoles(userId);
      const userType = userRoles && userRoles.length > 0 ? userRoles[0] : 'User';
      
      const messageId = await MessageQueueService.sendUserWelcome({
        tenantId: user.TenantId,
        userId: userId,
        userEmail: userDetails.Email,
        firstName: userDetails.FirstName || 'User',
        userType: userType,
        setupUrl: passwordSetupLink,
        createdBy: user.UserId
      });
      console.log(`✅ Queued welcome email for ${userDetails.Email}: ${messageId}`);
      emailResult = { messageId, success: true };
    } catch (error) {
      console.error(`❌ Failed to queue welcome email for ${userDetails.Email}:`, error);
      emailResult = { error: error.message, success: false };
    }

    return {
      passwordSetupLink,
      passwordSetupExpiry: passwordResetExpiry,
      emailResult
    };
  }

  /**
   * Update user information
   * @param {Object} user - Current authenticated user
   * @param {string} userId - User ID to update
   * @param {Object} userData - User data to update
   * @returns {Promise<void>}
   */
  static async updateUser(user, userId, userData) {
    const pool = await getPool();
    
    // Verify user exists and belongs to current user's context
    const userExists = await this.verifyUserAccess(user, userId, pool);
    if (!userExists) {
      throw new Error('User not found or access denied');
    }

    const { firstName, lastName, email, phoneNumber } = userData;

    const updateRequest = pool.request();
    updateRequest.input('userId', sql.UniqueIdentifier, userId);
    updateRequest.input('firstName', sql.NVarChar, firstName);
    updateRequest.input('lastName', sql.NVarChar, lastName);
    updateRequest.input('email', sql.NVarChar, email);
    updateRequest.input('phoneNumber', sql.NVarChar, phoneNumber || null);
    updateRequest.input('modifiedBy', sql.UniqueIdentifier, user.UserId);

    const updateQuery = `
      UPDATE oe.Users 
      SET FirstName = @firstName,
          LastName = @lastName,
          Email = @email,
          PhoneNumber = @phoneNumber,
          ModifiedDate = GETDATE(),
          ModifiedBy = @modifiedBy
      WHERE UserId = @userId
    `;

    await updateRequest.query(updateQuery);
  }

  /**
   * Update user status
   * @param {Object} user - Current authenticated user
   * @param {string} userId - User ID to update
   * @param {string} status - New status
   * @returns {Promise<void>}
   */
  static async updateUserStatus(user, userId, status) {
    const pool = await getPool();
    
    // Verify user exists and belongs to current user's context
    const userExists = await this.verifyUserAccess(user, userId, pool);
    if (!userExists) {
      throw new Error('User not found or access denied');
    }

    const updateRequest = pool.request();
    updateRequest.input('userId', sql.UniqueIdentifier, userId);
    updateRequest.input('status', sql.NVarChar, status);
    updateRequest.input('modifiedBy', sql.UniqueIdentifier, user.UserId);

    const updateQuery = `
      UPDATE oe.Users 
      SET Status = @status, ModifiedDate = GETDATE(), ModifiedBy = @modifiedBy
      WHERE UserId = @userId
    `;

    await updateRequest.query(updateQuery);
  }

  /**
   * Delete rows that FK-reference oe.Users so DELETE FROM oe.Users succeeds.
   * Ignores missing tables in environments that have not run every migration.
   */
  static async deleteUserDependentRows(pool, userId) {
    const tables = ['oe.RefreshTokens', 'oe.UserSessions', 'oe.UserRoles'];
    for (const table of tables) {
      try {
        await pool
          .request()
          .input('userId', sql.UniqueIdentifier, userId)
          .query(`DELETE FROM ${table} WHERE UserId = @userId`);
      } catch (err) {
        const msg = err?.message || String(err);
        if (/invalid object name/i.test(msg)) {
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Permanently delete oe.Users after clearing FK dependents.
   */
  static async deleteUserRecord(pool, userId) {
    await UserManagementService.deleteUserDependentRows(pool, userId);
    await pool
      .request()
      .input('userId', sql.UniqueIdentifier, userId)
      .query('DELETE FROM oe.Users WHERE UserId = @userId');
  }

  /**
   * Compute TenantId + AdditionalTenants after promoting a new primary tenant.
   * Keeps access to the old primary by moving it into AdditionalTenants.
   */
  static buildPrimaryTenantSwap(currentPrimaryId, additionalTenantIds, newPrimaryTenantId) {
    const isMatch = (a, b) => tenantIdsMatch(a, b);
    const validNewPrimary =
      isMatch(newPrimaryTenantId, currentPrimaryId) ||
      additionalTenantIds.some((id) => isMatch(id, newPrimaryTenantId));
    if (!validNewPrimary) {
      throw new Error('Invalid primary tenant selection.');
    }
    if (isMatch(newPrimaryTenantId, currentPrimaryId)) {
      return {
        newPrimaryTenantId: currentPrimaryId,
        additionalTenantIds: [...additionalTenantIds]
      };
    }

    const rest = additionalTenantIds.filter((id) => !isMatch(id, newPrimaryTenantId));
    const nextAdditional = [...rest];
    if (!isMatch(currentPrimaryId, newPrimaryTenantId)) {
      nextAdditional.push(currentPrimaryId);
    }

    const seen = new Set();
    const deduped = [];
    for (const tid of nextAdditional) {
      const key = String(tid).replace(/[{}]/gi, '').toLowerCase();
      if (!tid || seen.has(key) || isMatch(tid, newPrimaryTenantId)) continue;
      seen.add(key);
      deduped.push(tid);
    }

    return {
      newPrimaryTenantId,
      additionalTenantIds: deduped
    };
  }

  /**
   * Delete user
   * @param {Object} user - Current authenticated user
   * @param {string} userId - User ID to delete
   * @returns {Promise<void>}
   */
  static async deleteUser(user, userId, pool) {
    // Verify user exists and belongs to current user's context
    const userExists = await this.verifyUserAccess(user, userId, pool);
    if (!userExists) {
      throw new Error('User not found or access denied');
    }

    // Prevent deleting your own account
    if (userId === user.UserId) {
      throw new Error('You cannot delete your own account');
    }

    await UserManagementService.deleteUserRecord(pool, userId);
  }

  /**
   * Remove tenant admin access for the active tenant (does not delete oe.Users unless requested).
   * Supports additional-tenant removal, primary migration, and last-tenant role-only / soft / permanent delete.
   */
  static parseAdditionalTenantsJson(raw) {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (id) => id && String(id).trim() !== '' && String(id) !== '00000000-0000-0000-0000-000000000000'
      );
    } catch (_e) {
      return [];
    }
  }

  static async loadUserWithAccessToTenant(pool, userId, tenantId) {
    const result = await pool
      .request()
      .input('userId', sql.UniqueIdentifier, userId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT UserId, Email, FirstName, LastName, TenantId, AdditionalTenants, Status
        FROM oe.Users u
        WHERE UserId = @userId
          AND (
            u.TenantId = @tenantId
            OR (
              ISJSON(u.AdditionalTenants) = 1
              AND EXISTS (
                SELECT 1
                FROM OPENJSON(u.AdditionalTenants) AS j
                WHERE TRY_CAST(LTRIM(RTRIM(j.value)) AS UNIQUEIDENTIFIER) = @tenantId
              )
            )
          )
      `);
    return result.recordset[0] || null;
  }

  static async fetchTenantNameRows(pool, tenantIds) {
    const ids = [...new Set(tenantIds.filter(Boolean))];
    if (ids.length === 0) return [];
    const request = pool.request();
    const placeholders = ids.map((id, index) => {
      const param = `tid${index}`;
      request.input(param, sql.UniqueIdentifier, id);
      return `@${param}`;
    });
    const result = await request.query(`
      SELECT TenantId, Name
      FROM oe.Tenants
      WHERE TenantId IN (${placeholders.join(', ')})
    `);
    return result.recordset;
  }

  static countAccessibleTenantsExcept(primaryTenantId, additionalTenantIds, excludeTenantId) {
    const seen = new Set();
    const all = [primaryTenantId, ...additionalTenantIds];
    let count = 0;
    for (const tid of all) {
      if (!tid || seen.has(String(tid).toLowerCase())) continue;
      seen.add(String(tid).toLowerCase());
      if (!tenantIdsMatch(tid, excludeTenantId)) count += 1;
    }
    return count;
  }

  static async getTenantAdminRemovalPreview(actorUser, targetUserId, activeTenantId, pool) {
    const row = await UserManagementService.loadUserWithAccessToTenant(pool, targetUserId, activeTenantId);
    if (!row) {
      throw new Error('User not found or does not have tenant admin access for this organization');
    }

    if (String(row.UserId) === String(actorUser.UserId)) {
      throw new Error('You cannot remove your own tenant admin access. Ask another tenant admin to change your role.');
    }

    const roles = await UserRolesService.getUserRoleNames(targetUserId);
    if (!roles.includes('TenantAdmin')) {
      throw new Error('This user does not have tenant admin access for this organization.');
    }

    const additionalTenantIds = UserManagementService.parseAdditionalTenantsJson(row.AdditionalTenants);
    const isPrimaryHere = tenantIdsMatch(row.TenantId, activeTenantId);
    const otherRoles = roles.filter((r) => r !== 'TenantAdmin');
    const otherTenantAccessCount = UserManagementService.countAccessibleTenantsExcept(
      row.TenantId,
      additionalTenantIds,
      activeTenantId
    );

    if (isPrimaryHere && additionalTenantIds.length > 0) {
      const tenantRows = await UserManagementService.fetchTenantNameRows(pool, additionalTenantIds);
      const candidatePrimaryTenants = additionalTenantIds.map((tid) => {
        const match = tenantRows.find((t) => tenantIdsMatch(t.TenantId, tid));
        return { tenantId: tid, name: match?.Name || 'Unknown organization' };
      });

      return {
        scenario: 'primary_with_others',
        userId: row.UserId,
        email: row.Email,
        firstName: row.FirstName,
        lastName: row.LastName,
        isPrimaryHere: true,
        otherTenantAccessCount,
        candidatePrimaryTenants,
        requiresNewPrimaryTenant: true,
        allowedRemovalModes: ['removeRoleOnly']
      };
    }

    if (!isPrimaryHere) {
      return {
        scenario: 'additional_only',
        userId: row.UserId,
        email: row.Email,
        firstName: row.FirstName,
        lastName: row.LastName,
        isPrimaryHere: false,
        otherTenantAccessCount,
        requiresNewPrimaryTenant: false,
        allowedRemovalModes: ['removeRoleOnly']
      };
    }

    const allowedRemovalModes =
      otherRoles.length > 0
        ? ['removeRoleOnly']
        : ['removeRoleOnly', 'softDelete', 'permanentDelete'];

    return {
      scenario: 'last_tenant',
      userId: row.UserId,
      email: row.Email,
      firstName: row.LastName,
      lastName: row.LastName,
      isPrimaryHere: true,
      otherTenantAccessCount: 0,
      requiresNewPrimaryTenant: false,
      hasOtherRoles: otherRoles.length > 0,
      otherRoles,
      canPermanentDelete: otherRoles.length === 0,
      allowedRemovalModes
    };
  }

  static async removeTenantAdminAccess(actorUser, targetUserId, activeTenantId, options = {}, pool) {
    const { newPrimaryTenantId, removalMode = 'removeRoleOnly' } = options;

    const preview = await UserManagementService.getTenantAdminRemovalPreview(
      actorUser,
      targetUserId,
      activeTenantId,
      pool
    );

    const row = await UserManagementService.loadUserWithAccessToTenant(pool, targetUserId, activeTenantId);
    const additionalTenantIds = UserManagementService.parseAdditionalTenantsJson(row.AdditionalTenants);
    const isPrimaryHere = tenantIdsMatch(row.TenantId, activeTenantId);
    const modifiedBy = actorUser.UserId;

    if (preview.scenario === 'additional_only') {
      const updatedAdditional = additionalTenantIds.filter((id) => !tenantIdsMatch(id, activeTenantId));
      const additionalJson =
        updatedAdditional.length > 0 ? JSON.stringify(updatedAdditional) : null;

      await pool
        .request()
        .input('userId', sql.UniqueIdentifier, targetUserId)
        .input('additional', sql.NVarChar(sql.MAX), additionalJson)
        .input('modifiedBy', sql.UniqueIdentifier, modifiedBy)
        .query(`
          UPDATE oe.Users
          SET AdditionalTenants = @additional,
              ModifiedDate = GETDATE(),
              ModifiedBy = @modifiedBy
          WHERE UserId = @userId
        `);

      const remainingRoles = await UserRolesService.getUserRoleNames(targetUserId);
      return {
        message:
          'Removed tenant admin access to this organization. The user keeps their account and access to other organizations.',
        data: {
          remainingRoles,
          removedTenantAccessOnly: true,
          otherTenantsRetained: preview.otherTenantAccessCount
        }
      };
    }

    if (preview.scenario === 'primary_with_others') {
      if (!newPrimaryTenantId) {
        throw new Error('Select which organization should become their primary tenant.');
      }
      const validNewPrimary = additionalTenantIds.some((id) => tenantIdsMatch(id, newPrimaryTenantId));
      if (!validNewPrimary) {
        throw new Error('Invalid primary tenant selection.');
      }

      const rest = additionalTenantIds.filter((id) => !tenantIdsMatch(id, newPrimaryTenantId));
      const newAdditionalJson = rest.length > 0 ? JSON.stringify(rest) : null;

      await pool
        .request()
        .input('userId', sql.UniqueIdentifier, targetUserId)
        .input('newPrimary', sql.UniqueIdentifier, newPrimaryTenantId)
        .input('newAdditional', sql.NVarChar(sql.MAX), newAdditionalJson)
        .input('modifiedBy', sql.UniqueIdentifier, modifiedBy)
        .query(`
          UPDATE oe.Users
          SET TenantId = @newPrimary,
              AdditionalTenants = @newAdditional,
              ModifiedDate = GETDATE(),
              ModifiedBy = @modifiedBy
          WHERE UserId = @userId
        `);

      const remainingRoles = await UserRolesService.getUserRoleNames(targetUserId);
      return {
        message: `Removed access to this organization. They retain tenant admin access to ${preview.otherTenantAccessCount} other organization(s).`,
        data: {
          remainingRoles,
          removedTenantAccessOnly: true,
          otherTenantsRetained: preview.otherTenantAccessCount,
          newPrimaryTenantId
        }
      };
    }

    // last_tenant — only org they admin
    if (!preview.allowedRemovalModes.includes(removalMode)) {
      if (preview.hasOtherRoles && removalMode === 'permanentDelete') {
        throw new Error(
          'This user has other roles (e.g. Agent or Member). You can only remove tenant admin access — not permanently delete their account.'
        );
      }
      throw new Error('Invalid removal option for this user.');
    }

    if (removalMode === 'permanentDelete') {
      await UserManagementService.deleteUserRecord(pool, targetUserId);
      return {
        message: 'User account permanently deleted.',
        data: { permanentlyDeleted: true, removedTenantAccessOnly: false, otherTenantsRetained: 0 }
      };
    }

    if (removalMode === 'softDelete') {
      await pool
        .request()
        .input('userId', sql.UniqueIdentifier, targetUserId)
        .input('modifiedBy', sql.UniqueIdentifier, modifiedBy)
        .query(`
          UPDATE oe.Users
          SET Status = 'Inactive',
              ModifiedDate = GETDATE(),
              ModifiedBy = @modifiedBy
          WHERE UserId = @userId
        `);
      await UserRolesService.removeRoleFromUser(targetUserId, 'TenantAdmin');
      const remainingRoles = await UserRolesService.getUserRoleNames(targetUserId);
      return {
        message: 'User deactivated and tenant admin access removed for this organization.',
        data: { softDeleted: true, remainingRoles, removedTenantAccessOnly: false, otherTenantsRetained: 0 }
      };
    }

    await UserRolesService.removeRoleFromUser(targetUserId, 'TenantAdmin');
    const remainingRoles = await UserRolesService.getUserRoleNames(targetUserId);
    return {
      message: preview.hasOtherRoles
        ? 'Tenant admin role removed. The user keeps their other roles and can still sign in.'
        : 'Tenant admin access removed for this organization. The user account remains in the system.',
      data: { remainingRoles, removedTenantAccessOnly: false, otherTenantsRetained: 0 }
    };
  }

  /** @deprecated Use removeTenantAdminAccess */
  static async removeTenantAdminForTenant(actorUser, targetUserId, activeTenantId, pool) {
    return UserManagementService.removeTenantAdminAccess(
      actorUser,
      targetUserId,
      activeTenantId,
      { removalMode: 'removeRoleOnly' },
      pool
    );
  }

  static async loadTenantAdminUserRow(pool, userId) {
    const result = await pool
      .request()
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`
        SELECT UserId, Email, FirstName, LastName, TenantId, AdditionalTenants, Status
        FROM oe.Users
        WHERE UserId = @userId
      `);
    return result.recordset[0] || null;
  }

  static listAccessibleTenantIds(primaryTenantId, additionalTenantIds) {
    const seen = new Set();
    const ids = [];
    for (const tid of [primaryTenantId, ...additionalTenantIds]) {
      if (!tid) continue;
      const key = String(tid).replace(/[{}]/gi, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ids.push(tid);
    }
    return ids;
  }

  static async getPrimaryTenantChangePreview(_actorUser, targetUserId, _activeTenantId, pool) {
    const row = await UserManagementService.loadTenantAdminUserRow(pool, targetUserId);
    if (!row) {
      throw new Error('User not found');
    }

    const roles = await UserRolesService.getUserRoleNames(targetUserId);
    if (!roles.includes('TenantAdmin')) {
      throw new Error('This user does not have tenant admin access.');
    }

    const additionalTenantIds = UserManagementService.parseAdditionalTenantsJson(row.AdditionalTenants);
    const accessibleTenantIds = UserManagementService.listAccessibleTenantIds(
      row.TenantId,
      additionalTenantIds
    );
    const tenantRows = await UserManagementService.fetchTenantNameRows(pool, accessibleTenantIds);
    const accessibleTenants = accessibleTenantIds.map((tid) => {
      const match = tenantRows.find((t) => tenantIdsMatch(t.TenantId, tid));
      return {
        tenantId: tid,
        name: match?.Name || 'Unknown organization',
        isPrimary: tenantIdsMatch(tid, row.TenantId)
      };
    });

    return {
      userId: row.UserId,
      email: row.Email,
      firstName: row.FirstName,
      lastName: row.LastName,
      currentPrimaryTenantId: row.TenantId,
      accessibleTenants,
      canChangePrimary: accessibleTenants.length > 1
    };
  }

  static async changePrimaryTenant(actorUser, targetUserId, newPrimaryTenantId, pool) {
    if (!newPrimaryTenantId) {
      throw new Error('Select which organization should be their primary tenant.');
    }

    const row = await UserManagementService.loadTenantAdminUserRow(pool, targetUserId);
    if (!row) {
      throw new Error('User not found');
    }

    const roles = await UserRolesService.getUserRoleNames(targetUserId);
    if (!roles.includes('TenantAdmin')) {
      throw new Error('This user does not have tenant admin access.');
    }

    const additionalTenantIds = UserManagementService.parseAdditionalTenantsJson(row.AdditionalTenants);
    const swap = UserManagementService.buildPrimaryTenantSwap(
      row.TenantId,
      additionalTenantIds,
      newPrimaryTenantId
    );

    if (tenantIdsMatch(swap.newPrimaryTenantId, row.TenantId)) {
      return {
        message: 'Primary organization unchanged.',
        data: {
          newPrimaryTenantId: row.TenantId,
          unchanged: true
        }
      };
    }

    const newAdditionalJson =
      swap.additionalTenantIds.length > 0 ? JSON.stringify(swap.additionalTenantIds) : null;

    await pool
      .request()
      .input('userId', sql.UniqueIdentifier, targetUserId)
      .input('newPrimary', sql.UniqueIdentifier, swap.newPrimaryTenantId)
      .input('newAdditional', sql.NVarChar(sql.MAX), newAdditionalJson)
      .input('modifiedBy', sql.UniqueIdentifier, actorUser.UserId)
      .query(`
        UPDATE oe.Users
        SET TenantId = @newPrimary,
            AdditionalTenants = @newAdditional,
            ModifiedDate = GETDATE(),
            ModifiedBy = @modifiedBy
        WHERE UserId = @userId
      `);

    const tenantRows = await UserManagementService.fetchTenantNameRows(pool, [swap.newPrimaryTenantId]);
    const primaryName = tenantRows[0]?.Name || 'Unknown organization';

    return {
      message: `Primary organization updated to ${primaryName}.`,
      data: {
        newPrimaryTenantId: swap.newPrimaryTenantId,
        unchanged: false
      }
    };
  }

  // Helper methods

  /**
   * Get valid user types for current role
   */
  static getValidUserTypes(currentRole) {
    switch (currentRole) {
      case 'TenantAdmin':
        return ['TenantAdmin']; // Only TenantAdmins can create other TenantAdmins
      case 'GroupAdmin':
        return ['GroupAdmin'];
      default:
        return [];
    }
  }

  /**
   * Get group ID for GroupAdmin user
   */
  static async getGroupIdForUser(userId, pool) {
    // Try multiple methods to find the group
    // Create new request for GroupAdmins check
    let groupRequest = pool.request();
    groupRequest.input('userId', sql.UniqueIdentifier, userId);
    
    let groupResult = await groupRequest.query(`
      SELECT g.GroupId, g.TenantId, g.Name as GroupName
      FROM oe.GroupAdmins ga
      JOIN oe.Groups g ON ga.GroupId = g.GroupId
      WHERE ga.UserId = @userId AND ga.Status = 'Active'
      AND g.Status = 'Active'
    `);

    if (groupResult.recordset.length === 0) {
      // Create new request for Members check
      groupRequest = pool.request();
      groupRequest.input('userId', sql.UniqueIdentifier, userId);
      
      groupResult = await groupRequest.query(`
        SELECT g.GroupId, g.TenantId, g.Name as GroupName
        FROM oe.Members m
        JOIN oe.Groups g ON m.GroupId = g.GroupId
        WHERE m.UserId = @userId AND m.Status = 'Active'
        AND g.Status = 'Active'
      `);
    }

    // If still no group found, try matching by email (for group admins created during onboarding)
    if (groupResult.recordset.length === 0) {
      // Create new request for user email lookup
      groupRequest = pool.request();
      groupRequest.input('userId', sql.UniqueIdentifier, userId);
      
      const userResult = await groupRequest.query(`
        SELECT Email, TenantId FROM oe.Users WHERE UserId = @userId
      `);
      
      if (userResult.recordset.length > 0) {
        const userEmail = userResult.recordset[0].Email;
        const userTenantId = userResult.recordset[0].TenantId;
        
        // Create new request for group email match
        groupRequest = pool.request();
        groupRequest.input('userEmail', sql.NVarChar, userEmail);
        groupRequest.input('userTenantId', sql.UniqueIdentifier, userTenantId);
        
        groupResult = await groupRequest.query(`
          SELECT g.GroupId, g.TenantId, g.Name as GroupName
          FROM oe.Groups g
          WHERE g.ContactEmail = @userEmail 
          AND g.TenantId = @userTenantId
          AND g.Status = 'Active'
        `);
      }
    }

    return groupResult.recordset.length > 0 ? groupResult.recordset[0].GroupId : null;
  }

  /**
   * Revoke GroupAdmin for a user in a specific group without deleting oe.Users or oe.Members
   * (avoids FK_Members_Users / enrollment-related constraints).
   */
  static async revokeGroupAdminAccessForGroup(actorUser, targetUserId, groupId, pool) {
    if (String(targetUserId).toLowerCase() === String(actorUser.UserId).toLowerCase()) {
      throw new Error('You cannot remove your own administrator account from here.');
    }

    const verifyRequest = pool.request();
    verifyRequest.input('userId', sql.UniqueIdentifier, targetUserId);
    verifyRequest.input('groupId', sql.UniqueIdentifier, groupId);
    const existingUserResult = await verifyRequest.query(`
      SELECT TOP 1 u.UserId
      FROM oe.Users u
      WHERE u.UserId = @userId
        AND (
          EXISTS (
            SELECT 1
            FROM oe.GroupAdmins ga
            WHERE ga.UserId = u.UserId
              AND ga.GroupId = @groupId
              AND ga.Status = 'Active'
          )
          OR EXISTS (
            SELECT 1
            FROM oe.Members m
            INNER JOIN oe.UserRoles ur ON m.UserId = ur.UserId
            INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
            WHERE m.UserId = u.UserId
              AND m.GroupId = @groupId
              AND r.Name = 'GroupAdmin'
          )
        )
    `);

    if (existingUserResult.recordset.length === 0) {
      const err = new Error('User not found or access denied.');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      const roleRequest = transaction.request();
      roleRequest.input('roleName', sql.NVarChar, 'GroupAdmin');
      const roleResult = await roleRequest.query(`SELECT RoleId FROM oe.Roles WHERE Name = @roleName`);
      if (roleResult.recordset.length === 0) {
        throw new Error(`Role 'GroupAdmin' not found in oe.Roles table`);
      }
      const roleId = roleResult.recordset[0].RoleId;

      const gaReq = transaction.request();
      gaReq.input('userId', sql.UniqueIdentifier, targetUserId);
      gaReq.input('groupId', sql.UniqueIdentifier, groupId);
      await gaReq.query(`
        UPDATE oe.GroupAdmins
        SET Status = 'Inactive', ModifiedDate = GETUTCDATE()
        WHERE UserId = @userId AND GroupId = @groupId AND Status = 'Active'
      `);

      const countReq = transaction.request();
      countReq.input('userId', sql.UniqueIdentifier, targetUserId);
      const remainingGa = await countReq.query(`
        SELECT COUNT(*) AS cnt
        FROM oe.GroupAdmins
        WHERE UserId = @userId AND Status = 'Active'
      `);
      const activeGaCount = Number(remainingGa.recordset[0]?.cnt ?? 0);

      if (activeGaCount === 0) {
        const delRolesReq = transaction.request();
        delRolesReq.input('userId', sql.UniqueIdentifier, targetUserId);
        delRolesReq.input('roleId', sql.UniqueIdentifier, roleId);
        await delRolesReq.query(`
          DELETE FROM oe.UserRoles WHERE UserId = @userId AND RoleId = @roleId
        `);
      }

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  /**
   * Verify user access based on current role
   */
  static async verifyUserAccess(user, targetUserId, pool) {
    if (user.currentRole === 'TenantAdmin') {
      const checkRequest = pool.request();
      checkRequest.input('userId', sql.UniqueIdentifier, targetUserId);
      checkRequest.input('tenantId', sql.UniqueIdentifier, user.TenantId);
      
      const result = await checkRequest.query(`
        SELECT UserId FROM oe.Users 
        WHERE UserId = @userId AND TenantId = @tenantId
      `);
      
      return result.recordset.length > 0;
    } else if (user.currentRole === 'GroupAdmin') {
      const groupId = await this.getGroupIdForUser(user.UserId, pool);
      if (!groupId) return false;

      const checkRequest = pool.request();
      checkRequest.input('userId', sql.UniqueIdentifier, targetUserId);
      checkRequest.input('groupId', sql.UniqueIdentifier, groupId);
      
      const result = await checkRequest.query(`
        SELECT u.UserId 
        FROM oe.Users u
        INNER JOIN oe.Members m ON u.UserId = m.UserId
        INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId
        INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
        WHERE u.UserId = @userId AND m.GroupId = @groupId AND r.Name = 'GroupAdmin'
      `);
      
      return result.recordset.length > 0;
    }
    
    return false;
  }

  /**
   * Create Agent record
   */
  static async createAgentRecord(transaction, userId, user) {
    const agentId = crypto.randomUUID();
    const agentCode = await generateAgentCode(transaction, user.TenantId);
    const createAgentRequest = transaction.request();
    createAgentRequest.input('agentId', sql.UniqueIdentifier, agentId);
    createAgentRequest.input('userId', sql.UniqueIdentifier, userId);
    createAgentRequest.input('tenantId', sql.UniqueIdentifier, user.TenantId);
    createAgentRequest.input('status', sql.NVarChar, 'Active');
    createAgentRequest.input('agentCode', sql.NVarChar(50), agentCode);
    createAgentRequest.input('createdBy', sql.UniqueIdentifier, user.UserId);

    const createAgentQuery = `
      INSERT INTO oe.Agents (
        AgentId, UserId, TenantId, Status, AgentCode, CreatedDate, CreatedBy
      ) VALUES (
        @agentId, @userId, @tenantId, @status, @agentCode, GETDATE(), @createdBy
      )
    `;

    await createAgentRequest.query(createAgentQuery);
  }

  /**
   * Create Member record for GroupAdmin
   */
  static async createMemberRecord(transaction, userId, groupId, user) {
    const memberId = crypto.randomUUID();
    const createMemberRequest = transaction.request();
    createMemberRequest.input('memberId', sql.UniqueIdentifier, memberId);
    createMemberRequest.input('userId', sql.UniqueIdentifier, userId);
    createMemberRequest.input('groupId', sql.UniqueIdentifier, groupId);
    createMemberRequest.input('relationshipType', sql.NVarChar, 'P');
    createMemberRequest.input('status', sql.NVarChar, 'Active');
    createMemberRequest.input('createdBy', sql.UniqueIdentifier, user.UserId);

    const createMemberQuery = `
      INSERT INTO oe.Members (
        MemberId, UserId, GroupId, RelationshipType, Status, CreatedDate, CreatedBy
      ) VALUES (
        @memberId, @userId, @groupId, @relationshipType, @status, GETDATE(), @createdBy
      )
    `;

    await createMemberRequest.query(createMemberQuery);
  }

}

module.exports = UserManagementService;
