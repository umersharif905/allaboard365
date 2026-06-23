const express = require('express');
const router = express.Router();
const { authorize, requireTenantAccess } = require('../../../middleware/auth');
const UserManagementService = require('../../../services/shared/user-management.service');
const sql = require('mssql');
const { getPool } = require('../../../config/database');
const MessageQueueService = require('../../../services/messageQueue.service');

// GET Group Admin Users - Get all GroupAdmin users for the current group
router.get('/', authorize(['GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const filters = {
      search: req.query.search,
      userType: 'GroupAdmin', // GroupAdmins can only see other GroupAdmins
      status: req.query.status,
      sortBy: req.query.sortBy || 'FirstName',
      sortOrder: req.query.sortOrder || 'ASC',
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 50
    };

    console.log('🔍 Fetching group admin users with filters:', filters);

    const result = await UserManagementService.getUsers(req.user, filters);

    res.json({
      success: true,
      data: result.users,
      pagination: result.pagination
    });

  } catch (error) {
    console.error('❌ Error fetching group admin users:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch users'
    });
  }
});

// POST Create Group Admin User
router.post('/', authorize(['GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phoneNumber,
      sendWelcomeEmail = true
    } = req.body;

    console.log('📝 Creating group admin user:', {
      firstName,
      lastName,
      email,
      tenantId: req.user.TenantId,
      requestedBy: req.user.currentRole
    });

    // Validation
    if (!firstName || !lastName || !email) {
      return res.status(400).json({
        success: false,
        message: 'First name, last name, and email are required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    const result = await UserManagementService.createUser(req.user, {
      firstName,
      lastName,
      email,
      phoneNumber,
      userType: 'GroupAdmin', // GroupAdmins can only create other GroupAdmins
      sendWelcomeEmail
    }, req);

    console.log(`🔗 Password Setup Link for ${email}: ${result.passwordSetupLink}`);

    res.json({
      success: true,
      message: 'Group admin user created successfully',
      data: result
    });

  } catch (error) {
    console.error('❌ Error creating group admin user:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create user'
    });
  }
});

// POST Resend Password Setup Link
router.post('/:id/resend-link', authorize(['GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { id } = req.params;

    console.log('📧 Resending password setup link for user:', id);

    const result = await UserManagementService.resendPasswordSetupLink(req.user, id, req);

    console.log(`🔗 New Password Setup Link: ${result.passwordSetupLink}`);

    res.json({
      success: true,
      message: 'Password setup link resent successfully',
      data: result
    });

  } catch (error) {
    console.error('❌ Error resending password setup link:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to resend password setup link'
    });
  }
});

// POST Resend Sign In Email (for users who already have a password)
router.post('/:id/resend-signin-email', authorize(['GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await getPool();

    // Must be within this GroupAdmin's group
    const groupId = await UserManagementService.getGroupIdForUser(req.user.UserId, pool);
    if (!groupId) {
      return res.status(404).json({ success: false, message: 'No active group found for this admin' });
    }

    // Ensure target is a GroupAdmin for this group
    const canTarget = await pool.request()
      .input('userId', sql.UniqueIdentifier, id)
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT TOP 1 u.UserId, u.Email, u.FirstName, u.PasswordHash
        FROM oe.Users u
        INNER JOIN oe.Members m ON u.UserId = m.UserId
        INNER JOIN oe.UserRoles ur ON u.UserId = ur.UserId
        INNER JOIN oe.Roles r ON ur.RoleId = r.RoleId
        WHERE u.UserId = @userId AND m.GroupId = @groupId AND r.Name = 'GroupAdmin'
      `);

    if (canTarget.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found or access denied' });
    }

    const target = canTarget.recordset[0];
    if (!target.PasswordHash) {
      return res.status(400).json({ success: false, message: 'User has not set a password yet. Use resend password setup email instead.' });
    }

    const baseUrl = await UserManagementService.resolveLinkBaseUrl(req, req.user.TenantId);
    const loginUrl = `${String(baseUrl).replace(/\/+$/, '')}/login`;

    const groupNameResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`SELECT Name FROM oe.Groups WHERE GroupId = @groupId`);
    const groupName = groupNameResult.recordset[0]?.Name;

    const htmlContent = `
      <h2>Group Admin Access</h2>
      <p>Hi ${target.FirstName || 'there'},</p>
      <p>You have access as a <strong>Group Admin</strong>${groupName ? ` for <strong>${groupName}</strong>` : ''}.</p>
      <p>You can sign in using your existing credentials and navigate to the Group Admin portal from your dashboard.</p>
      <p style="margin: 24px 0;">
        <a href="${loginUrl}" style="background-color:#2563eb;color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px;display:inline-block;">
          Sign in
        </a>
      </p>
      <p>If the button doesn’t work, copy and paste this link into your browser:</p>
      <p style="word-break: break-all; color:#666; background:#f9fafb; padding:10px; border-radius:4px;">${loginUrl}</p>
    `;

    const subject = `Group Admin Access${groupName ? ` - ${groupName}` : ''}`;

    const messageId = await MessageQueueService.queueEmail({
      tenantId: req.user.TenantId,
      toEmail: target.Email,
      toName: target.FirstName,
      subject,
      htmlContent,
      messageType: 'Email',
      createdBy: req.user.UserId,
      recipientId: id
    });

    res.json({ success: true, message: 'Sign-in email sent', data: { messageId } });
  } catch (error) {
    console.error('❌ Error resending sign-in email:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to send sign-in email' });
  }
});

// PUT Update User
router.put('/:id', authorize(['GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { firstName, lastName, email, phoneNumber, userType } = req.body;

    console.log('✏️ Updating group admin user:', { userId: id, updates: req.body });

    // Validation
    if (!firstName || !lastName || !email || !userType) {
      return res.status(400).json({
        success: false,
        message: 'First name, last name, email, and user type are required'
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    await UserManagementService.updateUser(req.user, id, {
      firstName,
      lastName,
      email,
      phoneNumber,
      userType
    });

    res.json({
      success: true,
      message: 'User updated successfully'
    });

  } catch (error) {
    console.error('❌ Error updating group admin user:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update user'
    });
  }
});

// PUT Update User Status
router.put('/:id/status', authorize(['GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['Active', 'Inactive', 'Suspended'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be Active, Inactive, or Suspended'
      });
    }

    console.log('🔄 Updating user status:', { userId: id, status });

    await UserManagementService.updateUserStatus(req.user, id, status);

    res.json({
      success: true,
      message: 'User status updated successfully'
    });

  } catch (error) {
    console.error('❌ Error updating user status:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update user status'
    });
  }
});

// DELETE — remove Group Admin access for this group (does not delete oe.Users / oe.Members)
router.delete('/:id', authorize(['GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { id } = req.params;

    console.log('🗑️ Revoking group admin access:', { userId: id, requestedBy: req.user.currentRole });

    const { getPool } = require('../../../config/database');
    const pool = await getPool();

    const groupId = await UserManagementService.getGroupIdForUser(req.user.UserId, pool);
    if (!groupId) {
      return res.status(404).json({
        success: false,
        message: 'No active group found for this admin',
        code: 'GROUP_NOT_FOUND'
      });
    }

    await UserManagementService.revokeGroupAdminAccessForGroup(req.user, id, groupId, pool);

    res.json({
      success: true,
      message:
        'Group administrator access removed. Their login account and member records stay in the system.',
      code: 'GROUP_ADMIN_REMOVED'
    });
  } catch (error) {
    console.error('❌ Error revoking group admin user:', error);
    const httpStatus = error.code === 'NOT_FOUND' ? 404 : 500;
    res.status(httpStatus).json({
      success: false,
      message: error.message || 'Failed to remove group administrator'
    });
  }
});

// GET Group Info - Get group information for the current group admin
router.get('/group-info', authorize(['GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    console.log('🔍 Fetching group info for group admin:', req.user.UserId);

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
