const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const bcrypt = require('bcrypt');
const passwordRequirements = require('../../constants/password-requirements');

/**
 * @route   POST /api/public/tenant-admin/verify-invitation
 * @desc    Verify tenant admin invitation token and return setup data
 * @access  Public (no authentication required)
 */
router.post('/verify-invitation', async (req, res) => {
  const logger = require('../../config/logger');
  logger.info('[PUBLIC-TENANT-ADMIN] Verifying invitation token');

  try {
    const { invitationToken } = req.body;

    if (!invitationToken) {
      return res.status(400).json({
        success: false,
        message: 'Invitation token is required'
      });
    }

    const pool = await getPool();

    // Find user with this invitation token
    const userResult = await pool.request()
      .input('invitationToken', sql.NVarChar, invitationToken)
      .query(`
        SELECT 
          u.UserId, u.FirstName, u.LastName, u.Email, u.Status,
          u.TenantId, u.TenantAdminLink, u.TenantAdminLinkCreateDate,
          t.Name as TenantName,
          sysAdmin.FirstName + ' ' + sysAdmin.LastName as SysAdminName
        FROM oe.Users u
        INNER JOIN oe.Tenants t ON u.TenantId = t.TenantId
        LEFT JOIN oe.Users sysAdmin ON u.CreatedBy = sysAdmin.UserId
        WHERE u.TenantAdminLink = @invitationToken
        AND u.Status = 'PendingInvitation'
      `);

    if (userResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired invitation token'
      });
    }

    const user = userResult.recordset[0];

    // Check if invitation has expired (30 days)
    const invitationDate = new Date(user.TenantAdminLinkCreateDate);
    const now = new Date();
    const hoursDiff = (now - invitationDate) / (1000 * 60 * 60);

    if (hoursDiff > 30 * 24) {
      return res.status(400).json({
        success: false,
        message: 'This invitation has expired. Please request a new invitation.'
      });
    }

    logger.info(`✅ Invitation verified for: ${user.Email}`);

    res.json({
      success: true,
      data: {
        firstName: user.FirstName,
        lastName: user.LastName,
        email: user.Email,
        userId: user.UserId,
        tenantId: user.TenantId,
        tenantName: user.TenantName,
        sysAdminName: user.SysAdminName || 'System Administrator'
      },
      message: 'Invitation verified successfully'
    });

  } catch (error) {
    logger.error('❌ Error verifying invitation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify invitation',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

/**
 * @route   POST /api/public/tenant-admin/setup-password
 * @desc    Setup password for tenant admin after invitation verification
 * @access  Public (no authentication required)
 */
router.post('/setup-password', async (req, res) => {
  const logger = require('../../config/logger');
  logger.info('[PUBLIC-TENANT-ADMIN] Setting up password for tenant admin');

  try {
    const { invitationToken, password } = req.body;

    if (!invitationToken || !password) {
      return res.status(400).json({
        success: false,
        message: 'Invitation token and password are required'
      });
    }

    // Validate password strength (HIPAA compliant)
    const passwordRegex = passwordRequirements.getPasswordRegexMin8();
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        success: false,
        message: passwordRequirements.PASSWORD_REQUIREMENTS.messages.fullMin8
      });
    }

    const pool = await getPool();

    // Find user with this invitation token
    const userResult = await pool.request()
      .input('invitationToken', sql.NVarChar, invitationToken)
      .query(`
        SELECT 
          u.UserId, u.FirstName, u.LastName, u.Email, u.Status,
          u.TenantId, u.TenantAdminLink, u.TenantAdminLinkCreateDate,
          t.Name as TenantName
        FROM oe.Users u
        INNER JOIN oe.Tenants t ON u.TenantId = t.TenantId
        WHERE u.TenantAdminLink = @invitationToken
        AND u.Status = 'PendingInvitation'
      `);

    if (userResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired invitation token'
      });
    }

    const user = userResult.recordset[0];

    // Check if invitation has expired (30 days)
    const invitationDate = new Date(user.TenantAdminLinkCreateDate);
    const now = new Date();
    const hoursDiff = (now - invitationDate) / (1000 * 60 * 60);

    if (hoursDiff > 30 * 24) {
      return res.status(400).json({
        success: false,
        message: 'This invitation has expired. Please request a new invitation.'
      });
    }

    // Hash the password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Update user with password and activate account
    await pool.request()
      .input('userId', sql.UniqueIdentifier, user.UserId)
      .input('passwordHash', sql.NVarChar, passwordHash)
      .input('status', sql.NVarChar, 'Active')
      .input('tenantAdminLink', sql.NVarChar, null) // Clear the invitation token
      .input('tenantAdminLinkCreateDate', sql.Date, null) // Clear the invitation date
      .input('modifiedDate', sql.DateTime2, now)
      .query(`
        UPDATE oe.Users SET
          PasswordHash = @passwordHash,
          Status = @status,
          TenantAdminLink = @tenantAdminLink,
          TenantAdminLinkCreateDate = @tenantAdminLinkCreateDate,
          ModifiedDate = @modifiedDate
        WHERE UserId = @userId
      `);

    logger.info(`✅ Password set successfully for tenant admin: ${user.Email}`);

    // Generate JWT token
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { 
        userId: user.UserId,
        email: user.Email,
        firstName: user.FirstName,
        lastName: user.LastName,
        tenantId: user.TenantId,
        tenantName: user.TenantName,
        userType: 'TenantAdmin',
        roles: ['TenantAdmin']
      },
      process.env.JWT_SECRET || 'fallback-secret',
      { expiresIn: '24h' }
    );

    // Log the action
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, user.TenantId)
      .input('userId', sql.UniqueIdentifier, user.UserId)
      .input('entityId', sql.UniqueIdentifier, user.UserId)
      .input('action', sql.NVarChar(100), 'TenantAdminActivated')
      .input('entityType', sql.NVarChar(50), 'User')
      .input('details', sql.NVarChar(sql.MAX), JSON.stringify({
        email: user.Email,
        tenantName: user.TenantName,
        activationMethod: 'InvitationPasswordSetup'
      }))
      .query(`
        INSERT INTO oe.AuditLogs (TenantId, UserId, EntityId, Action, EntityType, Details, CreatedDate)
        VALUES (@tenantId, @userId, @entityId, @action, @entityType, @details, GETDATE())
      `);

    res.json({
      success: true,
      data: {
        token: token,
        userId: user.UserId,
        email: user.Email,
        firstName: user.FirstName,
        lastName: user.LastName,
        tenantId: user.TenantId,
        tenantName: user.TenantName,
        userType: 'TenantAdmin',
        roles: ['TenantAdmin']
      },
      message: 'TenantAdmin account activated successfully!'
    });

  } catch (error) {
    logger.error('❌ Error setting up password:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to setup password',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

module.exports = router;



