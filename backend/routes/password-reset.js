const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const MessageQueueService = require('../services/messageQueue.service');
const { getPool, sql } = require('../config/database');
const posthog = require('../config/posthog');
const { activateUserAfterSuccessfulLogin } = require('../services/activateUserAfterLogin.service');

/**
 * Request password reset - generate token in-house, store in oe.Users, send email
 * POST /api/password-reset/request
 */
router.post('/request', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    console.log(`🔐 Password reset requested for: ${email}`);

    const pool = await getPool();
    const emailNorm = email.trim().toLowerCase();

    const userResult = await pool.request()
      .input('email', sql.NVarChar, emailNorm)
      .query(`
        SELECT UserId, FirstName, TenantId
        FROM oe.Users
        WHERE Email = @email
      `);

    if (userResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'EMAIL_NOT_FOUND',
        message: 'No account found with this email address.'
      });
    }

    const user = userResult.recordset[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiryHours = parseInt(process.env.PASSWORD_RESET_EXPIRY_HOURS || '1', 10);

    await pool.request()
      .input('userId', sql.UniqueIdentifier, user.UserId)
      .input('resetToken', sql.NVarChar, resetToken)
      .query(`
        UPDATE oe.Users
        SET ResetPasswordToken = @resetToken,
            ResetPasswordExpiry = DATEADD(HOUR, ${Math.max(1, expiryHours)}, GETUTCDATE()),
            ModifiedDate = GETUTCDATE()
        WHERE UserId = @userId
      `);

    console.log('✅ Reset token generated and stored for user');

    posthog.capture({
      distinctId: String(user.UserId),
      event: 'password reset requested',
      properties: {
        tenant_id: user.TenantId ? String(user.TenantId) : undefined,
      },
    });

    let firstName = user.FirstName || 'User';
    let tenantId = user.TenantId;

    // Queue password reset email via MessageQueue
    try {
      // Get tenant info for email branding
      let tenantName = 'AllAboard365';
      let primaryColor = '#1f6db0';
      let logoUrl = '/images/branding/allaboard365/allaboard365-logo-transparent.png';
      let customDomain = null;

      if (tenantId) {
        try {
          const pool = await getPool();
          const tenantQuery = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(`
              SELECT 
                t.Name,
                t.CustomDomain,
                t.AdvancedSettings
              FROM oe.Tenants t
              WHERE t.TenantId = @tenantId
            `);

          if (tenantQuery.recordset.length > 0) {
            const tenant = tenantQuery.recordset[0];
            tenantName = tenant.Name || 'AllAboard365';
            customDomain = tenant.CustomDomain;
            
            // Parse advanced settings for branding
            if (tenant.AdvancedSettings) {
              try {
                const advancedSettings = JSON.parse(tenant.AdvancedSettings);
                if (advancedSettings.branding) {
                  primaryColor = advancedSettings.branding.primaryColorHex || primaryColor;
                  logoUrl = advancedSettings.branding.logoUrl || logoUrl;
                }
              } catch (parseError) {
                console.warn('⚠️ Could not parse tenant advanced settings:', parseError.message);
              }
            }
          }
        } catch (tenantError) {
          console.warn('⚠️ Could not fetch tenant info for email branding:', tenantError.message);
        }
      }

      // Construct reset URL - use tenant custom domain if available
      const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
      let resetUrl = `${baseUrl}/reset-password/${resetToken}`;
      if (customDomain) {
        resetUrl = `https://${customDomain}/reset-password/${resetToken}`;
      }

      // Create HTML email content using table-based layout for maximum compatibility
      const htmlContent = `
        <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
        <html xmlns="http://www.w3.org/1999/xhtml">
        <head>
          <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Password Reset Request</title>
          <!--[if mso]>
          <noscript>
            <xml>
              <o:OfficeDocumentSettings>
                <o:PixelsPerInch>96</o:PixelsPerInch>
              </o:OfficeDocumentSettings>
            </xml>
          </noscript>
          <![endif]-->
        </head>
        <body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: Arial, sans-serif;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f4f4;">
            <tr>
              <td align="center" style="padding: 20px 0;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                  
                  <!-- Header with Logo -->
                  <tr>
                    <td align="center" style="padding: 30px 20px 20px 20px;">
                      <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                        <tr>
                          <td align="center">
                            <img src="${logoUrl}" alt="${tenantName}" style="max-height: 50px; max-width: 200px; display: block;" />
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  
                  <!-- Main Content -->
                  <tr>
                    <td style="padding: 0 30px 20px 30px;">
                      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                        <tr>
                          <td>
                            <h1 style="margin: 0 0 20px 0; font-size: 24px; font-weight: bold; color: ${primaryColor}; text-align: center; font-family: Arial, sans-serif;">
                              Password Reset Request
                            </h1>
                          </td>
                        </tr>
                        <tr>
                          <td>
                            <p style="margin: 0 0 15px 0; font-size: 16px; line-height: 1.5; color: #333333; font-family: Arial, sans-serif;">
                              Hello ${firstName},
                            </p>
                            <p style="margin: 0 0 20px 0; font-size: 16px; line-height: 1.5; color: #333333; font-family: Arial, sans-serif;">
                              We received a request to reset your password for your ${tenantName} account.
                            </p>
                            <p style="margin: 0 0 25px 0; font-size: 16px; line-height: 1.5; color: #333333; font-family: Arial, sans-serif;">
                              Click the button below to reset your password:
                            </p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  
                  <!-- CTA Button -->
                  <tr>
                    <td align="center" style="padding: 0 30px 30px 30px;">
                      <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                        <tr>
                          <td align="center" style="border-radius: 6px; background-color: ${primaryColor};">
                            <a href="${resetUrl}" style="display: inline-block; padding: 15px 30px; font-size: 16px; font-weight: bold; color: #ffffff; text-decoration: none; font-family: Arial, sans-serif; border-radius: 6px;">
                              Reset Password
                            </a>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  
                  <!-- Fallback Link -->
                  <tr>
                    <td style="padding: 0 30px 20px 30px;">
                      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                        <tr>
                          <td>
                            <p style="margin: 0 0 10px 0; font-size: 14px; color: #666666; font-family: Arial, sans-serif;">
                              If the button doesn't work, copy and paste this link into your browser:
                            </p>
                            <p style="margin: 0 0 20px 0; font-size: 14px; color: ${primaryColor}; font-family: Arial, sans-serif; word-break: break-all;">
                              <a href="${resetUrl}" style="color: ${primaryColor}; text-decoration: underline;">${resetUrl}</a>
                            </p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  
                  <!-- Security Notice -->
                  <tr>
                    <td style="padding: 0 30px 20px 30px;">
                      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                        <tr>
                          <td style="background-color: #f8f9fa; border-left: 4px solid ${primaryColor}; padding: 15px;">
                            <p style="margin: 0; font-size: 14px; color: #666666; font-family: Arial, sans-serif; line-height: 1.4;">
                              <strong style="color: #333333;">Important:</strong> This link will expire in 15 minutes for security reasons. 
                              If you didn't request this password reset, please ignore this email.
                            </p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="padding: 20px 30px 30px 30px; border-top: 1px solid #eeeeee;">
                      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                        <tr>
                          <td>
                            <p style="margin: 0; font-size: 14px; color: #666666; font-family: Arial, sans-serif;">
                              Best regards,<br />
                              The ${tenantName} Team
                            </p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `.trim();

      // Minify HTML to remove whitespace that breaks email client rendering
      let finalHtmlContent = htmlContent.trim();
      try {
        const EmailTemplatesService = require('../services/emailTemplates.service');
        finalHtmlContent = EmailTemplatesService.minifyHtml(htmlContent);
        console.log(`✅ HTML minified successfully`);
      } catch (minifyError) {
        console.warn('⚠️ HTML minification failed, using trimmed HTML:', minifyError.message);
        // Continue with trimmed HTML if minification fails
        finalHtmlContent = htmlContent.trim();
      }

      // Queue the email via MessageQueue - HTML only (no text version)
      const emailData = {
        tenantId: tenantId,
        toEmail: email,
        toName: firstName,
        subject: 'Reset Your Password',
        htmlContent: finalHtmlContent,
        messageType: 'Email',
        createdBy: null, // System generated
        recipientId: null
      };
      // Don't pass textContent at all - HTML only
      const messageId = await MessageQueueService.queueEmail(emailData);

      console.log(`✅ Password reset email queued successfully: ${messageId}`);
    } catch (emailError) {
      console.error('❌ Failed to queue password reset email:', emailError);
      console.error('❌ Email error message:', emailError.message);
      console.error('❌ Email error stack:', emailError.stack);
      // Don't fail the request if email fails - token is still valid
      console.warn('⚠️ Password reset token generated but email failed');
    }

    res.json({
      success: true,
      message: 'Password reset email sent successfully'
    });

  } catch (error) {
    console.error('❌ Password reset request failed:', error);
    console.error('❌ Error message:', error.message);
    console.error('❌ Error stack:', error.stack);
    console.error('❌ Full error:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to process password reset request',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Verify reset token and return email for display (no form if invalid)
 * GET /api/password-reset/verify/:token
 */
router.get('/verify/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token is required'
      });
    }
    const pool = await getPool();
    const result = await pool.request()
      .input('token', sql.NVarChar, token)
      .query(`
        SELECT Email
        FROM oe.Users
        WHERE ResetPasswordToken = @token
          AND ResetPasswordExpiry > GETUTCDATE()
      `);
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired reset link. Please request a new password reset.'
      });
    }
    res.json({
      success: true,
      email: result.recordset[0].Email
    });
  } catch (error) {
    console.error('❌ Password reset verify failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify reset link'
    });
  }
});

/**
 * Reset password - validate token in oe.Users, update PasswordHash in-house
 * POST /api/password-reset/reset
 */
router.post('/reset', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Token and new password are required'
      });
    }

    const passwordRequirements = require('../constants/password-requirements');
    const passwordRegex = passwordRequirements.getPasswordRegex();
    if (!passwordRegex.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: passwordRequirements.getPasswordErrorMessage()
      });
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('token', sql.NVarChar, token)
      .query(`
        SELECT UserId
        FROM oe.Users
        WHERE ResetPasswordToken = @token
          AND ResetPasswordExpiry > GETUTCDATE()
      `);

    if (result.recordset.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset link. Please request a new password reset.'
      });
    }

    const user = result.recordset[0];
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(newPassword, saltRounds);
    // PasswordHash column must be nvarchar(255) or longer (see ensure-password-hash-column-length.sql) or hash is truncated and login fails

    const updateResult = await pool.request()
      .input('userId', sql.UniqueIdentifier, user.UserId)
      .input('passwordHash', sql.NVarChar(255), passwordHash)
      .query(`
        UPDATE oe.Users
        SET PasswordHash = @passwordHash,
            ResetPasswordToken = NULL,
            ResetPasswordExpiry = NULL,
            ModifiedDate = GETUTCDATE()
        WHERE UserId = @userId
      `);

    if (updateResult.rowsAffected[0] === 0) {
      console.error('❌ Password reset UPDATE affected 0 rows for user:', user.UserId);
      return res.status(500).json({
        success: false,
        message: 'Failed to update password. Please try again or request a new reset link.'
      });
    }

    try {
      await activateUserAfterSuccessfulLogin(user.UserId);
    } catch (statusErr) {
      console.warn('⚠️ Failed to activate User/Agent after reset (non-fatal):', statusErr.message);
    }

    console.log('✅ Password reset completed for user:', user.UserId);

    posthog.capture({
      distinctId: String(user.UserId),
      event: 'password reset completed',
    });

    res.json({
      success: true,
      message: 'Password reset successfully'
    });
  } catch (error) {
    console.error('❌ Password reset failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reset password'
    });
  }
});

module.exports = router;
