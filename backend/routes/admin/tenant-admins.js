const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const { authenticate, authorize } = require('../../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');

/**
 * @route   POST /api/admin/tenant-admins
 * @desc    Create a new TenantAdmin user account and send invitation email
 * @access  SysAdmin only
 */
router.post('/', 
  authenticate,
  authorize(['SysAdmin']),
  async (req, res) => {
    const logger = require('../../config/logger');
    logger.info('[ADMIN-TENANT-ADMINS] Creating new TenantAdmin invitation');

    try {
      const { tenantId, email, firstName, lastName } = req.body;
      const sysAdminId = req.user.UserId;

      // Validation
      if (!tenantId || !email || !firstName || !lastName) {
        return res.status(400).json({
          success: false,
          message: 'All fields are required: tenantId, email, firstName, lastName'
        });
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({
          success: false,
          message: 'Please provide a valid email address'
        });
      }

      const pool = await getPool();

      // Check if tenant exists
      const tenantResult = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT TenantId, Name as TenantName, ContactEmail
          FROM oe.Tenants
          WHERE TenantId = @tenantId
        `);

      if (tenantResult.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Tenant not found'
        });
      }

      const tenant = tenantResult.recordset[0];

      // Check if user with this email already exists
      const existingUserResult = await pool.request()
        .input('email', sql.NVarChar, email)
        .query(`
          SELECT UserId, Email, Status
          FROM oe.Users
          WHERE Email = @email
        `);

      if (existingUserResult.recordset.length > 0) {
        const existingUser = existingUserResult.recordset[0];
        return res.status(409).json({
          success: false,
          message: 'A user with this email address already exists',
          code: 'USER_EXISTS',
          existingUserId: existingUser.UserId,
          existingStatus: existingUser.Status
        });
      }

      // Generate invitation token (similar to verification token)
      const invitationToken = uuidv4();
      const invitationExpiry = new Date();
      invitationExpiry.setDate(invitationExpiry.getDate() + 30); // 30 days expiry

      // Create user account with invitation fields
      const userId = uuidv4();
      const now = new Date();

      const transaction = pool.transaction();
      await transaction.begin();

      try {
        // Insert user with invitation fields
        await transaction.request()
          .input('userId', sql.UniqueIdentifier, userId)
          .input('firstName', sql.NVarChar, firstName)
          .input('lastName', sql.NVarChar, lastName)
          .input('email', sql.NVarChar, email)
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('status', sql.NVarChar, 'PendingInvitation')
          .input('createdDate', sql.DateTime2, now)
          .input('modifiedDate', sql.DateTime2, now)
          .input('createdBy', sql.UniqueIdentifier, sysAdminId)
          .input('modifiedBy', sql.UniqueIdentifier, sysAdminId)
          .input('tenantAdminLink', sql.NVarChar, invitationToken)
          .input('tenantAdminLinkCreateDate', sql.Date, now)
          .query(`
            INSERT INTO oe.Users (
              UserId, FirstName, LastName, Email, TenantId, Status,
              CreatedDate, ModifiedDate, CreatedBy, ModifiedBy,
              TenantAdminLink, TenantAdminLinkCreateDate
            ) VALUES (
              @userId, @firstName, @lastName, @email, @tenantId, @status,
              @createdDate, @modifiedDate, @createdBy, @modifiedBy,
              @tenantAdminLink, @tenantAdminLinkCreateDate
            )
          `);

        // Get TenantAdmin role ID
        const roleResult = await transaction.request()
          .query(`
            SELECT RoleId FROM oe.Roles WHERE Name = 'TenantAdmin'
          `);

        if (roleResult.recordset.length === 0) {
          throw new Error('TenantAdmin role not found');
        }

        const tenantAdminRoleId = roleResult.recordset[0].RoleId;

        // Assign TenantAdmin role
        await transaction.request()
          .input('userId', sql.UniqueIdentifier, userId)
          .input('roleId', sql.UniqueIdentifier, tenantAdminRoleId)
          .input('createdDate', sql.DateTime2, now)
          .input('createdBy', sql.UniqueIdentifier, sysAdminId)
          .query(`
            INSERT INTO oe.UserRoles (UserId, RoleId, CreatedDate, CreatedBy)
            VALUES (@userId, @roleId, @createdDate, @createdBy)
          `);

        await transaction.commit();

        logger.info(`✅ TenantAdmin user created successfully: ${email} for tenant: ${tenant.TenantName}`);

        // Send invitation email
        try {
          logger.info(`📧 Starting email sending process for: ${email}`);
          
          const EmailTemplatesService = require('../../services/emailTemplates.service');
          const MessageQueueService = require('../../services/messageQueue.service');
          
          // Generate invitation URL - use request origin if available, otherwise use tenant custom domain or default
          // Never use localhost as fallback
          let baseUrl = req.get('origin');
          if (!baseUrl && tenant.CustomDomain) {
            baseUrl = `https://${tenant.CustomDomain}`;
          }
          if (!baseUrl) {
            baseUrl = 'https://app.allaboard365.com';
          }
          const invitationUrl = `${baseUrl}/tenant-admin/setup-password?token=${invitationToken}`;
          logger.info(`📧 Invitation URL: ${invitationUrl}`);
          
          // Get SysAdmin name
          const sysAdminName = (req.user.FirstName || 'System') + ' ' + (req.user.LastName || 'Administrator');
          logger.info(`📧 Generating email template with SysAdmin: ${sysAdminName}`);
          
          // Generate HTML email from template
          const htmlContent = await EmailTemplatesService.generateTenantAdminInvitation({
            firstName: firstName,
            tenantName: tenant.TenantName,
            invitationUrl: invitationUrl,
            sysAdminName: sysAdminName
          });
          
          logger.info(`📧 Email template generated successfully. Queuing email...`);
          
          const messageId = await MessageQueueService.queueEmail({
            tenantId: tenantId,
            toEmail: email,
            toName: `${firstName} ${lastName}`,
            subject: `You've been invited to be a Tenant Admin for ${tenant.TenantName}`,
            htmlContent: htmlContent,
            textContent: null, // Remove plain text to avoid duplicate content
            messageType: 'Email',
            createdBy: sysAdminId
          });
          
          logger.info(`📧 ✅ TenantAdmin invitation email queued successfully with MessageId: ${messageId} to: ${email}`);
        } catch (emailError) {
          logger.error('❌ Failed to send invitation email - FULL ERROR:', emailError);
          logger.error('❌ Error stack:', emailError.stack);
          logger.error('❌ Error name:', emailError.name);
          logger.error('❌ Error message:', emailError.message);
          if (emailError.code) {
            logger.error('❌ Error code:', emailError.code);
          }
          if (emailError.originalError) {
            logger.error('❌ Original error:', emailError.originalError);
          }
          // Re-throw to see the actual error - temporarily for debugging
          throw emailError;
        }

        // Log the action
        await pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('userId', sql.UniqueIdentifier, sysAdminId)
          .input('entityId', sql.UniqueIdentifier, userId)
          .input('action', sql.NVarChar(100), 'TenantAdminCreated')
          .input('entityType', sql.NVarChar(50), 'User')
          .input('details', sql.NVarChar(sql.MAX), JSON.stringify({
            invitedEmail: email,
            invitedName: `${firstName} ${lastName}`,
            tenantName: tenant.TenantName,
            invitationToken: invitationToken
          }))
          .query(`
            INSERT INTO oe.AuditLogs (TenantId, UserId, EntityId, Action, EntityType, Details, CreatedDate)
            VALUES (@tenantId, @userId, @entityId, @action, @entityType, @details, GETDATE())
          `);

        res.json({
          success: true,
          data: {
            userId: userId,
            email: email,
            firstName: firstName,
            lastName: lastName,
            tenantName: tenant.TenantName,
            invitationToken: invitationToken,
            status: 'PendingInvitation'
          },
          message: 'TenantAdmin invitation sent successfully'
        });

      } catch (transactionError) {
        await transaction.rollback();
        logger.error('❌ Transaction failed:', transactionError);
        throw transactionError;
      }

    } catch (error) {
      logger.error('❌ Error creating TenantAdmin invitation:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to create TenantAdmin invitation',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
      });
    }
  }
);

module.exports = router;
