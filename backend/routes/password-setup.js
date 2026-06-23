const express = require('express');
const sql = require('mssql');
const jwt = require('jsonwebtoken');
const { getPool } = require('../config/database');
const { hashPassword } = require('../utils/passwordHash');
const posthog = require('../config/posthog');

const router = express.Router();

// GET /api/password-setup/:token/tenant-redirect - Get tenant redirection information
router.get('/:token/tenant-redirect', async (req, res) => {
  try {
    const { token } = req.params;
    
    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Password setup token is required'
      });
    }

    const pool = await getPool();
    
    // Get user and tenant info
    const query = `
      SELECT 
        u.UserId,
        u.Email,
        u.FirstName,
        u.LastName,
        u.TenantId,
        t.Name as TenantName,
        t.CustomDomain,
        t.DefaultUrlPath,
        t.IsDefaultUrlPathVerified
      FROM oe.Users u
      INNER JOIN oe.Tenants t ON u.TenantId = t.TenantId
      WHERE u.ResetPasswordToken = @token
        AND u.ResetPasswordExpiry > GETDATE()
        AND u.PasswordHash IS NULL
    `;
    
    const request = pool.request();
    request.input('token', sql.NVarChar, token);
    
    const result = await request.query(query);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired password setup link'
      });
    }
    
    const userInfo = result.recordset[0];
    
    // Determine redirect URL based on tenant configuration
    // Priority: 1. CustomDomain (if available and working) 2. DefaultUrlPath (if verified) 3. app.allaboard365.com
    let redirectUrl = 'https://app.allaboard365.com/login'; // Default fallback
    let redirectType = 'default';
    
    if (userInfo.CustomDomain && userInfo.CustomDomain.trim() !== '') {
      redirectUrl = `https://${userInfo.CustomDomain}/login`;
      redirectType = 'custom_domain';
    } else if (userInfo.DefaultUrlPath && userInfo.IsDefaultUrlPathVerified) {
      redirectUrl = `https://app.allaboard365.com/${userInfo.DefaultUrlPath}/login`;
      redirectType = 'default_url_path';
    }
    
    res.json({
      success: true,
      data: {
        tenantName: userInfo.TenantName,
        customDomain: userInfo.CustomDomain,
        defaultUrlPath: userInfo.DefaultUrlPath,
        redirectUrl,
        redirectType
      }
    });
    
  } catch (error) {
    console.error('❌ Error getting tenant redirect info:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get tenant redirect information'
    });
  }
});

// GET /api/password-setup/:token - Verify password setup token
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Password setup token is required'
      });
    }

    const pool = await getPool();
    
    // Verify token and get user info
    const query = `
      SELECT 
        u.UserId,
        u.Email,
        u.FirstName,
        u.LastName,
        u.Status,
        u.ResetPasswordToken,
        u.ResetPasswordExpiry,
        CASE WHEN u.PasswordHash IS NOT NULL THEN 1 ELSE 0 END AS HasPassword
      FROM oe.Users u
      WHERE u.ResetPasswordToken = @token
        AND u.ResetPasswordExpiry > GETDATE()
    `;
    
    const request = pool.request();
    request.input('token', sql.NVarChar, token);
    
    const result = await request.query(query);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired password setup link'
      });
    }
    
    const user = result.recordset[0];
    
    // Get user roles from UserRoles table
    const UserRolesService = require('../services/shared/user-roles.service');
    const userRoles = await UserRolesService.getUserRoleNames(user.UserId);
    
    res.json({
      success: true,
      message: user.HasPassword ? 'Password already set' : 'Password setup token is valid',
      data: {
        email: user.Email,
        firstName: user.FirstName,
        lastName: user.LastName,
        roles: userRoles,
        currentRole: userRoles[0],
        hasPassword: !!user.HasPassword // Return true if password already exists
      }
    });
    
  } catch (error) {
    console.error('❌ Error verifying password setup token:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify password setup token'
    });
  }
});

// POST /api/password-setup/:token - Setup password
router.post('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;
    
    if (!token || !password) {
      return res.status(400).json({
        success: false,
        message: 'Password setup token and password are required'
      });
    }

    // Validate password strength (HIPAA compliant)
    const passwordRequirements = require('../constants/password-requirements');
    const passwordRegex = passwordRequirements.getPasswordRegex();
    if (!passwordRegex.test(password)) {
      return res.status(400).json({
        success: false,
        message: passwordRequirements.getPasswordErrorMessage()
      });
    }

    const pool = await getPool();
    
    // Verify token and get user info
    const query = `
      SELECT 
        u.UserId,
        u.Email,
        u.FirstName,
        u.LastName,
        u.Status,
        u.ResetPasswordToken,
        u.ResetPasswordExpiry
      FROM oe.Users u
      WHERE u.ResetPasswordToken = @token
        AND u.ResetPasswordExpiry > GETDATE()
        AND u.PasswordHash IS NULL
    `;
    
    const request = pool.request();
    request.input('token', sql.NVarChar, token);
    
    const result = await request.query(query);
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Invalid or expired password setup link'
      });
    }
    
    const user = result.recordset[0];
    
    // Get user roles from UserRoles table
    const UserRolesService = require('../services/shared/user-roles.service');
    const userRoles = await UserRolesService.getUserRoleNames(user.UserId);
    
    const passwordHash = await hashPassword(password);
    
    // Update user with password and clear reset token
    const updateQuery = `
      UPDATE oe.Users SET
        PasswordHash = @passwordHash,
        Status = 'Active',
        ResetPasswordToken = NULL,
        ResetPasswordExpiry = NULL,
        ModifiedDate = GETDATE()
      WHERE UserId = @userId
    `;
    
    const updateRequest = pool.request();
    updateRequest.input('userId', sql.UniqueIdentifier, user.UserId);
    updateRequest.input('passwordHash', sql.NVarChar(255), passwordHash);
    
    await updateRequest.query(updateQuery);
    
    // Generate JWT token for immediate login
    const jwtPayload = {
      userId: user.UserId,
      email: user.Email,
      roles: userRoles,
      currentRole: userRoles[0],
      firstName: user.FirstName,
      lastName: user.LastName
    };
    
    const jwtToken = jwt.sign(jwtPayload, process.env.JWT_SECRET || 'fallback-secret', {
      expiresIn: '24h'
    });
    
    console.log(`✅ Password setup completed for ${user.Email}`);

    posthog.capture({
      distinctId: String(user.UserId),
      event: 'password setup completed',
      properties: {
        $set: {
          email: user.Email,
          first_name: user.FirstName,
          last_name: user.LastName,
          roles: userRoles,
        },
        roles: userRoles,
      },
    });

    res.json({
      success: true,
      message: 'Password setup completed successfully',
      data: {
        token: jwtToken,
        user: {
          userId: user.UserId,
          email: user.Email,
          firstName: user.FirstName,
          lastName: user.LastName,
          roles: userRoles,
          currentRole: userRoles[0],
          status: 'Active'
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Error setting up password:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to setup password'
    });
  }
});

module.exports = router;
