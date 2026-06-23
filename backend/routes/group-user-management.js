const express = require('express');
const router = express.Router({ mergeParams: true });
const crypto = require('crypto');
const { getPool, sql } = require('../config/database');
const { authorize: authMiddleware, getUserRoles } = require('../middleware/auth');
const { getAccessibleAgentIdsForUser, buildAgentScopeClause } = require('../utils/agentGroupAccess');

const UserRolesService = require('../services/shared/user-roles.service');
const UserManagementService = require('../services/shared/user-management.service');
const MessageQueueService = require('../services/messageQueue.service');
const { GROUP_DETAIL_READ_STATUS_SQL } = require('../utils/groupRouteAccess');

const DEFAULT_APP_BASE_URL = 'https://app.allaboard365.com';

const normalizeBaseUrl = (url) => String(url || '').replace(/\/+$/, '');

const getTenantDomainOptions = async (tenantId, pool) => {
  const tenantResult = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`SELECT CustomDomain, AdvancedSettings FROM oe.Tenants WHERE TenantId = @tenantId`);

  if (tenantResult.recordset.length === 0) return { customDomain: null };

  const tenant = tenantResult.recordset[0];
  let advancedSettings = {};
  try {
    advancedSettings = tenant.AdvancedSettings ? JSON.parse(tenant.AdvancedSettings) : {};
  } catch (_e) {
    advancedSettings = {};
  }

  const customDomain = tenant.CustomDomain || advancedSettings?.domain?.customDomain || null;
  return { customDomain };
};

const resolveLinkBaseUrl = async (req, tenantId, pool) => {
  const requested = req?.body?.linkBaseUrl;
  const origin = req?.get ? req.get('origin') : null;

  const { customDomain } = await getTenantDomainOptions(tenantId, pool);

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

  return (
    validate(requested) ||
    validate(origin) ||
    (customDomain ? `https://${String(customDomain).trim()}` : null) ||
    DEFAULT_APP_BASE_URL
  );
};

const sendGroupAdminAccessGrantedEmail = async ({ tenantId, userId, userEmail, firstName, baseUrl, createdBy, groupId, pool }) => {
  try {
    const groupResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`SELECT Name FROM oe.Groups WHERE GroupId = @groupId`);
    const groupName = groupResult.recordset[0]?.Name;

    const loginUrl = `${normalizeBaseUrl(baseUrl)}/login`;
    const htmlContent = `
      <h2>Group Admin Access Granted</h2>
      <p>Hi ${firstName || 'there'},</p>
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
      tenantId,
      toEmail: userEmail,
      toName: firstName,
      subject,
      htmlContent,
      messageType: 'Email',
      createdBy,
      recipientId: userId
    });

    return { messageId, success: true };
  } catch (e) {
    console.error('❌ Failed to queue access granted email:', e);
    return { error: e.message, success: false };
  }
};

const ensureGroupAccess = async (req, groupId, pool) => {
  const userRoles = getUserRoles(req.user);
  const isSysAdmin = userRoles.includes('SysAdmin');
  const isAgent = userRoles.includes('Agent') && req.user?.currentRole === 'Agent';

  const request = pool.request();
  request.input('groupId', sql.UniqueIdentifier, groupId);

  let accessQuery = `
    SELECT g.GroupId, g.TenantId, g.AgentId
    FROM oe.Groups g
    WHERE g.GroupId = @groupId
      AND ${GROUP_DETAIL_READ_STATUS_SQL}
  `;

  if (isAgent) {
    const accessibleAgentIds = await getAccessibleAgentIdsForUser(pool, req.user);
    if (accessibleAgentIds.length === 0) {
      return false;
    }
    const agentScopeClause = buildAgentScopeClause(request, accessibleAgentIds, 'g.AgentId', 'agUsers');
    accessQuery += ` AND ${agentScopeClause}`;
  } else if (!isSysAdmin) {
    request.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
    accessQuery += ' AND g.TenantId = @tenantId';
  }

  const groupResult = await request.query(accessQuery);
  return groupResult.recordset.length > 0 ? groupResult.recordset[0] : null;
};

const ensureTargetUserIsGroupAdminForGroup = async (pool, groupId, targetUserId) => {
  const request = pool.request();
  request.input('groupId', sql.UniqueIdentifier, groupId);
  request.input('userId', sql.UniqueIdentifier, targetUserId);

  const result = await request.query(`
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

  return result.recordset.length > 0;
};

/**
 * Ensure oe.GroupAdmins has an Active row for this user+group.
 * Group routes require this row when the user is acting as GroupAdmin (currentRole === 'GroupAdmin').
 */
const ensureGroupAdminRecord = async (pool, userId, groupId, createdBy) => {
  const check = await pool.request()
    .input('userId', sql.UniqueIdentifier, userId)
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`SELECT GroupAdminId, Status FROM oe.GroupAdmins WHERE UserId = @userId AND GroupId = @groupId`);
  if (check.recordset.length > 0) {
    const row = check.recordset[0];
    if (row.Status === 'Active') return;
    await pool.request()
      .input('userId', sql.UniqueIdentifier, userId)
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        UPDATE oe.GroupAdmins SET Status = 'Active', ModifiedDate = GETUTCDATE()
        WHERE UserId = @userId AND GroupId = @groupId
      `);
    return;
  }
  const groupAdminId = crypto.randomUUID();
  await pool.request()
    .input('groupAdminId', sql.UniqueIdentifier, groupAdminId)
    .input('userId', sql.UniqueIdentifier, userId)
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`
      INSERT INTO oe.GroupAdmins (GroupAdminId, UserId, GroupId, Status, AssignedDate, CreatedDate, ModifiedDate)
      VALUES (@groupAdminId, @userId, @groupId, 'Active', GETUTCDATE(), GETUTCDATE(), GETUTCDATE())
    `);
};

// GET /api/groups/:groupId/user-management - list GroupAdmin users for a specific group
router.get('/', authMiddleware(['SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
  try {
    const { groupId } = req.params;
    const pool = await getPool();

    const groupRow = await ensureGroupAccess(req, groupId, pool);
    if (!groupRow) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }

    const {
      search = '',
      status = '',
      sortBy = 'FirstName',
      sortOrder = 'ASC',
      page = '1',
      limit = '50',
    } = req.query;

    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 50;
    const offset = (pageNum - 1) * limitNum;

    const validSortFields = ['FirstName', 'LastName', 'Email', 'Status', 'CreatedDate', 'LastLoginDate'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'FirstName';
    const sortDirection = String(sortOrder).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    const whereClauses = [
      `m.GroupId = @groupId`,
      `r.Name = 'GroupAdmin'`,
    ];

    const request = pool.request();
    request.input('groupId', sql.UniqueIdentifier, groupId);

    if (search) {
      whereClauses.push(`(u.FirstName LIKE @search OR u.LastName LIKE @search OR u.Email LIKE @search)`);
      request.input('search', sql.NVarChar, `%${search}%`);
    }

    if (status) {
      whereClauses.push(`u.Status = @status`);
      request.input('status', sql.NVarChar, status);
    }

    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, limitNum);

    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const listQuery = `
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
      INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId
      INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
      ${whereSql}
      ORDER BY u.${sortField} ${sortDirection}
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;

    const result = await request.query(listQuery);

    // Count query
    const countRequest = pool.request();
    countRequest.input('groupId', sql.UniqueIdentifier, groupId);
    if (search) countRequest.input('search', sql.NVarChar, `%${search}%`);
    if (status) countRequest.input('status', sql.NVarChar, status);

    const countQuery = `
      SELECT COUNT(DISTINCT u.UserId) as Total
      FROM oe.Users u
      INNER JOIN oe.Members m ON u.UserId = m.UserId
      INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId
      INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
      ${whereSql}
    `;

    const countResult = await countRequest.query(countQuery);
    const total = countResult.recordset[0]?.Total || 0;

    const users = await Promise.all(result.recordset.map(async (u) => {
      const userRoles = await UserRolesService.getUserRoleNames(u.UserId);
      return {
        userId: u.UserId,
        email: u.Email,
        firstName: u.FirstName,
        lastName: u.LastName,
        status: u.Status,
        tenantId: u.TenantId,
        phoneNumber: u.PhoneNumber,
        createdDate: u.CreatedDate,
        modifiedDate: u.ModifiedDate,
        lastLoginDate: u.LastLoginDate,
        roles: userRoles,
        accountStatus: u.AccountStatus,
        hasPasswordSetupLink: !!u.ResetPasswordToken && u.ResetPasswordExpiry > new Date(),
        passwordSetupExpiry: u.ResetPasswordExpiry,
        passwordSetupToken: u.ResetPasswordToken,
      };
    }));

    res.json({
      success: true,
      data: users,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('❌ Error fetching group admin users for group:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to fetch users' });
  }
});

// POST /api/groups/:groupId/user-management - create GroupAdmin user for this group
router.post('/', authMiddleware(['SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
  const { groupId } = req.params;
  const pool = await getPool();

  try {
    const groupRow = await ensureGroupAccess(req, groupId, pool);
    if (!groupRow) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }

    const {
      firstName,
      lastName,
      email,
      phoneNumber,
      sendWelcomeEmail = true,
    } = req.body || {};

    if (!firstName || !lastName || !email) {
      return res.status(400).json({ success: false, message: 'First name, last name, and email are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }

    const baseUrl = await resolveLinkBaseUrl(req, groupRow.TenantId, pool);

    // If a user with this email already exists in this tenant, grant GroupAdmin access instead of failing.
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

      if (String(existingUser.TenantId).toLowerCase() !== String(groupRow.TenantId).toLowerCase()) {
        return res.status(400).json({
          success: false,
          message: 'A user with this email already exists in a different tenant. Cannot grant Group Admin access across tenants.'
        });
      }

      // Must be an active member of this group to promote. Other active memberships must not block.
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
        return res.status(400).json({
          success: false,
          message:
            'This email is tied to another group but is not an active member of this group. Add them to this group first.'
        });
      }

      // Disallow if already a GroupAdmin for this group
      const alreadyGroupAdminForGroup = await ensureTargetUserIsGroupAdminForGroup(pool, groupId, existingUser.UserId);
      if (alreadyGroupAdminForGroup) {
        return res.status(400).json({
          success: false,
          message: 'This email is already a Group Admin for this group.'
        });
      }

      // Ensure the user is linked to this group (Members) and active
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
          .input('createdBy', sql.UniqueIdentifier, req.user.UserId)
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
          .input('modifiedBy', sql.UniqueIdentifier, req.user.UserId)
          .query(`
            UPDATE oe.Members
            SET Status = 'Active',
                ModifiedDate = GETDATE(),
                ModifiedBy = @modifiedBy
            WHERE UserId = @userId AND GroupId = @groupId
          `);
      }

      const roleAssignResult = await UserRolesService.assignRoleToUser(existingUser.UserId, 'GroupAdmin', req.user.UserId);

      await ensureGroupAdminRecord(pool, existingUser.UserId, groupId, req.user.UserId);

      // Set user to Active if they were Pending so they can use group admin features immediately (no manual fix)
      if (existingUser.Status === 'Pending') {
        await pool.request()
          .input('userId', sql.UniqueIdentifier, existingUser.UserId)
          .input('modifiedBy', sql.UniqueIdentifier, req.user.UserId)
          .query(`
            UPDATE oe.Users SET Status = 'Active', ModifiedDate = GETUTCDATE(), ModifiedBy = @modifiedBy WHERE UserId = @userId
          `);
      }

      const passwordSetupRequired = existingUser.PasswordHash == null;
      let passwordSetupLink = null;
      let passwordSetupExpiry = null;
      let emailResult = { success: true, skipped: true };

      if (passwordSetupRequired) {
        const passwordResetToken = crypto.randomUUID();
        passwordSetupExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        await pool.request()
          .input('userId', sql.UniqueIdentifier, existingUser.UserId)
          .input('passwordResetToken', sql.NVarChar, passwordResetToken)
          .input('passwordResetExpiry', sql.DateTime2, passwordSetupExpiry)
          .input('modifiedBy', sql.UniqueIdentifier, req.user.UserId)
          .query(`
            UPDATE oe.Users
            SET ResetPasswordToken = @passwordResetToken,
                ResetPasswordExpiry = @passwordResetExpiry,
                ModifiedDate = GETDATE(),
                ModifiedBy = @modifiedBy
            WHERE UserId = @userId
          `);

        passwordSetupLink = `${baseUrl}/setup-password/${passwordResetToken}`;
        emailResult = { success: true, skipped: true };

        if (sendWelcomeEmail) {
          const MessageQueueService = require('../services/messageQueue.service');
          try {
            const messageId = await MessageQueueService.sendUserWelcome({
              tenantId: groupRow.TenantId,
              userId: existingUser.UserId,
              userEmail: existingUser.Email,
              firstName: existingUser.FirstName || firstName,
              userType: 'GroupAdmin',
              setupUrl: passwordSetupLink,
              createdBy: req.user.UserId,
            });
            emailResult = { messageId, success: true };
          } catch (e) {
            console.error(`❌ Failed to queue welcome email for ${existingUser.Email}:`, e);
            emailResult = { error: e.message, success: false };
          }
        }
      }

      if (!passwordSetupRequired && sendWelcomeEmail && !roleAssignResult?.alreadyAssigned) {
        emailResult = await sendGroupAdminAccessGrantedEmail({
          tenantId: groupRow.TenantId,
          userId: existingUser.UserId,
          userEmail: existingUser.Email,
          firstName: existingUser.FirstName || firstName,
          baseUrl,
          createdBy: req.user.UserId,
          groupId,
          pool
        });
      }

      return res.json({
        success: true,
        message: passwordSetupRequired
          ? 'Existing user found. Group Admin access granted and password setup link generated.'
          : 'Existing user found. Group Admin access granted. No password setup needed.',
        data: {
          userId: existingUser.UserId,
          email: existingUser.Email,
          firstName: existingUser.FirstName || firstName,
          lastName: existingUser.LastName || lastName,
          userType: 'GroupAdmin',
          status: existingUser.Status,
          existingUser: true,
          roleAlreadyAssigned: !!roleAssignResult?.alreadyAssigned,
          passwordSetupRequired,
          passwordSetupLink,
          passwordSetupExpiry,
          emailResult,
        }
      });
    }

    const transaction = pool.transaction();
    await transaction.begin();

    try {
      // Ensure email is unique
      const emailCheckRequest = transaction.request();
      emailCheckRequest.input('email', sql.NVarChar, email);
      const emailCheck = await emailCheckRequest.query('SELECT UserId FROM oe.Users WHERE Email = @email');
      if (emailCheck.recordset.length > 0) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: 'Email already exists' });
      }

      const userId = crypto.randomUUID();
      const passwordResetToken = crypto.randomUUID();
      const passwordResetExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const createUserRequest = transaction.request();
      createUserRequest.input('userId', sql.UniqueIdentifier, userId);
      createUserRequest.input('email', sql.NVarChar, email);
      createUserRequest.input('firstName', sql.NVarChar, firstName);
      createUserRequest.input('lastName', sql.NVarChar, lastName);
      createUserRequest.input('phoneNumber', sql.NVarChar, phoneNumber || null);
      createUserRequest.input('tenantId', sql.UniqueIdentifier, groupRow.TenantId);
      createUserRequest.input('status', sql.NVarChar, 'Active'); // Active so they can use app once they set password (no manual fix)
      createUserRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
      createUserRequest.input('passwordResetToken', sql.NVarChar, passwordResetToken);
      createUserRequest.input('passwordResetExpiry', sql.DateTime2, passwordResetExpiry);

      await createUserRequest.query(`
        INSERT INTO oe.Users (
          UserId, Email, FirstName, LastName, PhoneNumber,
          TenantId, Status, CreatedDate, CreatedBy, MfaEnabled,
          ResetPasswordToken, ResetPasswordExpiry
        ) VALUES (
          @userId, @email, @firstName, @lastName, @phoneNumber,
          @tenantId, @status, GETDATE(), @createdBy, 0,
          @passwordResetToken, @passwordResetExpiry
        )
      `);

      // Create Member record linked to this group
      const memberId = crypto.randomUUID();
      const createMemberRequest = transaction.request();
      createMemberRequest.input('memberId', sql.UniqueIdentifier, memberId);
      createMemberRequest.input('userId', sql.UniqueIdentifier, userId);
      createMemberRequest.input('groupId', sql.UniqueIdentifier, groupId);
      createMemberRequest.input('relationshipType', sql.NVarChar, 'P');
      createMemberRequest.input('status', sql.NVarChar, 'Active');
      createMemberRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);

      await createMemberRequest.query(`
        INSERT INTO oe.Members (
          MemberId, UserId, GroupId, RelationshipType, Status, CreatedDate, CreatedBy
        ) VALUES (
          @memberId, @userId, @groupId, @relationshipType, @status, GETDATE(), @createdBy
        )
      `);

      await transaction.commit();

      await UserRolesService.assignRoleToUser(userId, 'GroupAdmin', req.user.UserId);
      await ensureGroupAdminRecord(pool, userId, groupId, req.user.UserId);

      const passwordSetupLink = `${baseUrl}/setup-password/${passwordResetToken}`;

      // Send welcome email if requested
      let emailResult = null;
      if (sendWelcomeEmail) {
        const MessageQueueService = require('../services/messageQueue.service');
        try {
          const messageId = await MessageQueueService.sendUserWelcome({
            tenantId: groupRow.TenantId,
            userId,
            userEmail: email,
            firstName,
            userType: 'GroupAdmin',
            setupUrl: passwordSetupLink,
            createdBy: req.user.UserId,
          });
          emailResult = { messageId, success: true };
        } catch (e) {
          console.error(`❌ Failed to queue welcome email for ${email}:`, e);
          emailResult = { error: e.message, success: false };
        }
      }

      return res.json({
        success: true,
        message: 'Group admin user created successfully',
        data: {
          userId,
          email,
          firstName,
          lastName,
          userType: 'GroupAdmin',
          status: 'Active',
          passwordSetupLink,
          passwordSetupExpiry: passwordResetExpiry,
          emailResult,
        },
      });
    } catch (innerError) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        console.error('❌ Rollback failed:', rollbackError);
      }
      throw innerError;
    }
  } catch (error) {
    console.error('❌ Error creating group admin user for group:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to create user' });
  }
});

// POST /api/groups/:groupId/user-management/:id/resend-link
router.post('/:id/resend-link', authMiddleware(['SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
  try {
    const { groupId, id } = req.params;
    const pool = await getPool();

    const groupRow = await ensureGroupAccess(req, groupId, pool);
    if (!groupRow) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }

    const canTarget = await ensureTargetUserIsGroupAdminForGroup(pool, groupId, id);
    if (!canTarget) {
      return res.status(404).json({ success: false, message: 'User not found or access denied' });
    }

    const baseUrl = await resolveLinkBaseUrl(req, groupRow.TenantId, pool);
    const passwordResetToken = crypto.randomUUID();
    const passwordResetExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const updateRequest = pool.request();
    updateRequest.input('userId', sql.UniqueIdentifier, id);
    updateRequest.input('passwordResetToken', sql.NVarChar, passwordResetToken);
    updateRequest.input('passwordResetExpiry', sql.DateTime2, passwordResetExpiry);
    updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

    await updateRequest.query(`
      UPDATE oe.Users
      SET ResetPasswordToken = @passwordResetToken,
          ResetPasswordExpiry = @passwordResetExpiry,
          ModifiedDate = GETDATE(),
          ModifiedBy = @modifiedBy
      WHERE UserId = @userId
    `);

    // Fetch user details for email
    const userDetailsResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, id)
      .query(`SELECT Email, FirstName, LastName FROM oe.Users WHERE UserId = @userId`);

    const userDetails = userDetailsResult.recordset[0];

    const passwordSetupLink = `${baseUrl}/setup-password/${passwordResetToken}`;

    let emailResult = null;
    try {
      const MessageQueueService = require('../services/messageQueue.service');
      const messageId = await MessageQueueService.sendUserWelcome({
        tenantId: groupRow.TenantId,
        userId: id,
        userEmail: userDetails.Email,
        firstName: userDetails.FirstName || 'User',
        userType: 'GroupAdmin',
        setupUrl: passwordSetupLink,
        createdBy: req.user.UserId,
      });
      emailResult = { messageId, success: true };
    } catch (e) {
      console.error(`❌ Failed to queue welcome email for ${userDetails?.Email}:`, e);
      emailResult = { error: e.message, success: false };
    }

    res.json({
      success: true,
      message: 'Password setup link resent successfully',
      data: { passwordSetupLink, passwordSetupExpiry: passwordResetExpiry, emailResult },
    });
  } catch (error) {
    console.error('❌ Error resending password setup link (group scoped):', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to resend password setup link' });
  }
});

// POST /api/groups/:groupId/user-management/:id/resend-signin-email
router.post('/:id/resend-signin-email', authMiddleware(['SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
  try {
    const { groupId, id } = req.params;
    const pool = await getPool();

    const groupRow = await ensureGroupAccess(req, groupId, pool);
    if (!groupRow) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }

    const canTarget = await ensureTargetUserIsGroupAdminForGroup(pool, groupId, id);
    if (!canTarget) {
      return res.status(404).json({ success: false, message: 'User not found or access denied' });
    }

    const userResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, id)
      .query(`SELECT Email, FirstName, PasswordHash FROM oe.Users WHERE UserId = @userId`);

    if (userResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const target = userResult.recordset[0];
    if (!target.PasswordHash) {
      return res.status(400).json({ success: false, message: 'User has not set a password yet. Use resend password setup email instead.' });
    }

    const baseUrl = await resolveLinkBaseUrl(req, groupRow.TenantId, pool);
    const emailResult = await sendGroupAdminAccessGrantedEmail({
      tenantId: groupRow.TenantId,
      userId: id,
      userEmail: target.Email,
      firstName: target.FirstName,
      baseUrl,
      createdBy: req.user.UserId,
      groupId,
      pool
    });

    if (!emailResult.success) {
      return res.status(500).json({ success: false, message: emailResult.error || 'Failed to send sign-in email' });
    }

    res.json({ success: true, message: 'Sign-in email sent', data: emailResult });
  } catch (error) {
    console.error('❌ Error resending sign-in email (group scoped):', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to send sign-in email' });
  }
});

// PUT /api/groups/:groupId/user-management/:id - update user
router.put('/:id', authMiddleware(['SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
  try {
    const { groupId, id } = req.params;
    const pool = await getPool();

    const groupRow = await ensureGroupAccess(req, groupId, pool);
    if (!groupRow) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }

    const canTarget = await ensureTargetUserIsGroupAdminForGroup(pool, groupId, id);
    if (!canTarget) {
      return res.status(404).json({ success: false, message: 'User not found or access denied' });
    }

    const { firstName, lastName, email, phoneNumber } = req.body || {};

    if (!firstName || !lastName || !email) {
      return res.status(400).json({ success: false, message: 'First name, last name, and email are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }

    const updateRequest = pool.request();
    updateRequest.input('userId', sql.UniqueIdentifier, id);
    updateRequest.input('firstName', sql.NVarChar, firstName);
    updateRequest.input('lastName', sql.NVarChar, lastName);
    updateRequest.input('email', sql.NVarChar, email);
    updateRequest.input('phoneNumber', sql.NVarChar, phoneNumber || null);
    updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

    await updateRequest.query(`
      UPDATE oe.Users
      SET FirstName = @firstName,
          LastName = @lastName,
          Email = @email,
          PhoneNumber = @phoneNumber,
          ModifiedDate = GETDATE(),
          ModifiedBy = @modifiedBy
      WHERE UserId = @userId
    `);

    res.json({ success: true, message: 'User updated successfully' });
  } catch (error) {
    console.error('❌ Error updating group admin user (group scoped):', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to update user' });
  }
});

// PUT /api/groups/:groupId/user-management/:id/status - update status
router.put('/:id/status', authMiddleware(['SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
  try {
    const { groupId, id } = req.params;
    const { status } = req.body || {};

    if (!['Active', 'Inactive', 'Suspended'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status. Must be Active, Inactive, or Suspended' });
    }

    const pool = await getPool();

    const groupRow = await ensureGroupAccess(req, groupId, pool);
    if (!groupRow) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }

    const canTarget = await ensureTargetUserIsGroupAdminForGroup(pool, groupId, id);
    if (!canTarget) {
      return res.status(404).json({ success: false, message: 'User not found or access denied' });
    }

    const updateRequest = pool.request();
    updateRequest.input('userId', sql.UniqueIdentifier, id);
    updateRequest.input('status', sql.NVarChar, status);
    updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);

    await updateRequest.query(`
      UPDATE oe.Users
      SET Status = @status,
          ModifiedDate = GETDATE(),
          ModifiedBy = @modifiedBy
      WHERE UserId = @userId
    `);

    res.json({ success: true, message: 'User status updated successfully' });
  } catch (error) {
    console.error('❌ Error updating user status (group scoped):', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to update user status' });
  }
});

// DELETE /api/groups/:groupId/user-management/:id - revoke Group Admin for this group (does not delete oe.Users / oe.Members)
router.delete('/:id', authMiddleware(['SysAdmin', 'TenantAdmin', 'Agent']), async (req, res) => {
  try {
    const { groupId, id } = req.params;
    const pool = await getPool();

    const groupRow = await ensureGroupAccess(req, groupId, pool);
    if (!groupRow) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }

    const canTarget = await ensureTargetUserIsGroupAdminForGroup(pool, groupId, id);
    if (!canTarget) {
      return res.status(404).json({ success: false, message: 'User not found or access denied' });
    }

    // Prevent deleting your own account
    if (id === req.user.UserId) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account' });
    }

    try {
      await UserManagementService.revokeGroupAdminAccessForGroup(req.user, id, groupId, pool);
      return res.json({
        success: true,
        message:
          'Group administrator access removed for this group. Their login account stays in the system; if they are still enrolled as a member here, remove them from Members separately.',
        code: 'GROUP_ADMIN_REMOVED'
      });
    } catch (revokeErr) {
      const httpStatus = revokeErr.code === 'NOT_FOUND' ? 404 : 500;
      return res.status(httpStatus).json({
        success: false,
        message: revokeErr.message || 'Failed to remove group administrator.'
      });
    }
  } catch (error) {
    console.error('❌ Error deleting user (group scoped):', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to delete user' });
  }
});

module.exports = router;

