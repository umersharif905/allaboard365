// backend/routes/local-auth.js
// Local auth endpoints (login, me, refresh, logout) using oe.Users + JWT.
// Session limits are configured for HIPAA alignment: short access token, absolute session cap.

const express = require('express');
const posthog = require('../config/posthog');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getPool, sql } = require('../config/database');
const UserRolesService = require('../services/shared/user-roles.service');
const { getLoginMetadataForUser } = require('../services/memberHouseholdLoginContext.service');
const {
  userCanCompleteAb365MemberLogin,
  shouldGateAb365MemberPasswordLogin,
} = require('../services/mobileAb365LoginEligibility.service');

const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY || '1h';
const ABSOLUTE_SESSION_HOURS = parseInt(process.env.ABSOLUTE_SESSION_HOURS || '1680', 10);
const PERSISTENT_SESSION_DAYS = parseInt(process.env.PERSISTENT_SESSION_DAYS || '90', 10);
const JWT_SECRET = process.env.JWT_SECRET;
const ABSOLUTE_SESSION_MS = ABSOLUTE_SESSION_HOURS * 60 * 60 * 1000;
const PERSISTENT_SESSION_MS = PERSISTENT_SESSION_DAYS * 24 * 60 * 60 * 1000;

/**
 * POST /auth/login
 * Body: { email, password, keepMeSignedIn? }
 * Returns: accessToken, refreshToken, roles, tenantId, userId, email, firstName?, lastName?, phoneNumber?
 */
router.post('/login', async (req, res) => {
  try {
    if (!JWT_SECRET) {
      console.error('❌ [local-auth] JWT_SECRET is not set');
      return res.status(500).json({
        success: false,
        message: 'Server configuration error'
      });
    }

    const { email, password, keepMeSignedIn } = req.body;
    const persistentSession = keepMeSignedIn === true;
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    const emailNorm = email.trim().toLowerCase();
    console.log('🔐 [login] Attempt for email:', emailNorm);

    const pool = await getPool();
    const request = pool.request();
    request.input('email', sql.NVarChar, emailNorm);

    const userResult = await request.query(`
      SELECT 
        u.UserId,
        u.Email,
        u.FirstName,
        u.LastName,
        u.TenantId,
        u.PhoneNumber,
        u.PasswordHash,
        u.Status
      FROM oe.Users u
      WHERE u.Email = @email
    `);

    if (userResult.recordset.length === 0) {
      console.log('🔐 [login] No user found for email:', emailNorm);
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const user = userResult.recordset[0];
    if (user.Status !== 'Active') {
      console.log('🔐 [login] User account is not active:', user.UserId, 'Status:', user.Status);
      const statusMessage = (user.Status || '').toString().toLowerCase() === 'pending'
        ? 'Account is not active or is pending activation.'
        : 'Account is no longer active. Please contact support for help.';
      return res.status(401).json({
        success: false,
        message: statusMessage
      });
    }
    if (!user.PasswordHash) {
      console.log('🔐 [login] User has no password set:', user.UserId);
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const hashLen = user.PasswordHash ? user.PasswordHash.length : 0;
    console.log('🔐 [login] User found:', user.UserId, 'PasswordHash length:', hashLen);
    const valid = await bcrypt.compare(password, user.PasswordHash);
    if (!valid) {
      console.log('🔐 [login] bcrypt.compare FAILED for userId:', user.UserId);
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }
    console.log('🔐 [login] bcrypt.compare OK for userId:', user.UserId);

    const roles = await UserRolesService.getUserRoleNames(user.UserId);
    if (!roles || roles.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'User has no roles assigned'
      });
    }

    // Member-only logins without AB365 member context must use ShareWELL legacy (mobile defer).
    // Staff with Member + TenantAdmin/Agent/etc. are not gated — portal tenant/agent login.
    if (
      shouldGateAb365MemberPasswordLogin(roles) &&
      !(await userCanCompleteAb365MemberLogin(user.UserId))
    ) {
      console.log('[login] reject incomplete AB365 member-only login for userId:', user.UserId);
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const sessionStartedAt = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const userAgent = req.headers['user-agent'] || null;

    // Persist session row before issuing refresh token so /auth/refresh can always validate it.
    try {
      const insertSessionRequest = pool.request();
      insertSessionRequest.input('sessionId', sql.UniqueIdentifier, sessionId);
      insertSessionRequest.input('userId', sql.UniqueIdentifier, user.UserId);
      insertSessionRequest.input('userAgent', sql.NVarChar, userAgent);
      await insertSessionRequest.query(`
        INSERT INTO oe.UserSessions (SessionId, UserId, UserAgent)
        VALUES (@sessionId, @userId, @userAgent)
      `);
    } catch (sessionError) {
      console.error('❌ [local-auth] Failed to create UserSessions row; refusing login:', sessionError.message);
      return res.status(500).json({
        success: false,
        message: 'Unable to start secure session. Please try again.'
      });
    }

    const accessPayload = {
      userId: user.UserId,
      email: user.Email,
      tenantId: user.TenantId,
      roles,
      sessionStartedAt
    };
    const accessToken = jwt.sign(accessPayload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });

    const refreshPayload = {
      userId: user.UserId,
      email: user.Email,
      sessionStartedAt,
      sessionId,
      persistentSession,
      type: 'refresh'
    };
    const refreshToken = jwt.sign(refreshPayload, JWT_SECRET, {
      expiresIn: persistentSession ? `${PERSISTENT_SESSION_DAYS}d` : `${ABSOLUTE_SESSION_HOURS}h`
    });

    try {
      const updateRequest = pool.request();
      updateRequest.input('userId', sql.UniqueIdentifier, user.UserId);
      await updateRequest.query(`
        UPDATE oe.Users SET LastLoginDate = GETDATE() WHERE UserId = @userId
      `);
    } catch (updateError) {
      console.warn('⚠️ [local-auth] Failed to update LastLoginDate:', updateError.message);
    }

    const tenantId = user.TenantId != null ? String(user.TenantId) : '';
    const userId = String(user.UserId);

    posthog.capture({
      distinctId: userId,
      event: 'user logged in',
      properties: {
        $set: {
          email: user.Email,
          first_name: user.FirstName,
          last_name: user.LastName,
          tenant_id: tenantId,
          roles,
        },
        roles,
        tenant_id: tenantId,
        persistent_session: persistentSession,
      },
    });

    let memberId;
    let householdMemberId;
    if (roles.includes('Member')) {
      try {
        const loginMeta = await getLoginMetadataForUser(user.UserId);
        memberId = loginMeta.memberId;
        householdMemberId = loginMeta.householdMemberId;
      } catch (metaErr) {
        console.warn('[local-auth] member login metadata skipped:', metaErr.message);
      }
    }

    res.json({
      accessToken,
      refreshToken,
      roles,
      tenantId,
      userId,
      email: user.Email,
      firstName: user.FirstName || undefined,
      lastName: user.LastName || undefined,
      phoneNumber: user.PhoneNumber || undefined,
      memberId,
      householdMemberId,
    });
  } catch (error) {
    console.error('❌ [local-auth] Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed'
    });
  }
});

/**
 * GET /auth/me
 * Authorization: Bearer <accessToken>
 * Returns: { message, user: { userId, email } }
 */
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token || !JWT_SECRET) {
      return res.status(401).json({
        success: false,
        message: 'Access token required'
      });
    }

    const payload = jwt.verify(token, JWT_SECRET);
    const userId = payload.userId;
    const email = payload.email;
    if (!userId || !email) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token'
      });
    }

    res.json({
      message: 'OK',
      user: { userId: String(userId), email }
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token'
      });
    }
    console.error('❌ [local-auth] /me error:', error);
    res.status(500).json({
      success: false,
      message: 'Request failed'
    });
  }
});

/**
 * POST /auth/refresh
 * Body: { refreshToken }
 * Returns: { accessToken, refreshToken }
 * Enforces absolute session cap (e.g. 12h from login).
 */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken || !JWT_SECRET) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token required'
      });
    }

    const payload = jwt.verify(refreshToken, JWT_SECRET);
    if (payload.type !== 'refresh') {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token'
      });
    }

    const sessionStartedAt = payload.sessionStartedAt;
    if (!sessionStartedAt) {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token'
      });
    }

    const started = new Date(sessionStartedAt).getTime();
    const now = Date.now();
    const persistentSession = payload.persistentSession === true;
    const absoluteSessionMs = persistentSession ? PERSISTENT_SESSION_MS : ABSOLUTE_SESSION_MS;
    if (now - started > absoluteSessionMs) {
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please log in again.'
      });
    }

    const pool = await getPool();
    const sessionId = payload.sessionId;
    if (sessionId) {
      const sessionRequest = pool.request();
      sessionRequest.input('sessionId', sql.UniqueIdentifier, sessionId);
      const sessionResult = await sessionRequest.query(`
        SELECT SessionId, UserId, RevokedAt
        FROM oe.UserSessions
        WHERE SessionId = @sessionId
      `);
      if (sessionResult.recordset.length === 0 || sessionResult.recordset[0].RevokedAt != null) {
        return res.status(401).json({
          success: false,
          message: 'Session has been revoked. Please log in again.'
        });
      }
      const updateActivityRequest = pool.request();
      updateActivityRequest.input('sessionId', sql.UniqueIdentifier, sessionId);
      await updateActivityRequest.query(`
        UPDATE oe.UserSessions SET LastActivityAt = GETUTCDATE() WHERE SessionId = @sessionId
      `).catch(() => {});
    }

    const request = pool.request();
    request.input('userId', sql.UniqueIdentifier, payload.userId);

    const userResult = await request.query(`
      SELECT UserId, Email, TenantId, Status
      FROM oe.Users
      WHERE UserId = @userId AND Status = 'Active'
    `);

    if (userResult.recordset.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'User not found or inactive'
      });
    }

    const user = userResult.recordset[0];
    const roles = await UserRolesService.getUserRoleNames(user.UserId);

    const accessPayload = {
      userId: user.UserId,
      email: user.Email,
      tenantId: user.TenantId,
      roles,
      sessionStartedAt
    };
    const newAccessToken = jwt.sign(accessPayload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });

    const newRefreshPayload = {
      userId: user.UserId,
      email: user.Email,
      sessionStartedAt,
      sessionId: sessionId || null,
      persistentSession,
      type: 'refresh'
    };
    const newRefreshToken = jwt.sign(newRefreshPayload, JWT_SECRET, {
      expiresIn: persistentSession ? `${PERSISTENT_SESSION_DAYS}d` : `${ABSOLUTE_SESSION_HOURS}h`
    });

    res.json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired refresh token'
      });
    }
    console.error('❌ [local-auth] Refresh error:', error);
    res.status(500).json({
      success: false,
      message: 'Refresh failed'
    });
  }
});

/**
 * POST /auth/logout
 * Revokes session when refresh token body provided; otherwise client-only clear.
 */
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (refreshToken && JWT_SECRET) {
      try {
        const payload = jwt.verify(refreshToken, JWT_SECRET);
        if (payload.sessionId) {
          const pool = await getPool();
          await pool.request()
            .input('sessionId', sql.UniqueIdentifier, payload.sessionId)
            .query(`
              UPDATE oe.UserSessions SET RevokedAt = GETUTCDATE()
              WHERE SessionId = @sessionId AND RevokedAt IS NULL
            `);
        }
      } catch (_) {
        // ignore invalid token on logout
      }
    }
    res.status(200).json({ message: 'OK' });
  } catch (error) {
    console.error('❌ [local-auth] logout error:', error);
    res.status(200).json({ message: 'OK' });
  }
});

const LoginOtpService = require('../services/login-otp.service');

/**
 * POST /auth/otp/request
 */
router.post('/otp/request', async (req, res) => {
  try {
    const result = await LoginOtpService.requestOtp(req, req.body);
    const status = result.status || 200;
    delete result.status;
    return res.status(status).json(result);
  } catch (error) {
    console.error('❌ [local-auth] otp/request error:', error);
    return res.status(500).json({
      success: false,
      codeSent: false,
      failureReason: 'server_error',
      message: "We couldn't send your sign-in code. Please try again.",
    });
  }
});

/**
 * POST /auth/otp/verify
 */
router.post('/otp/verify', async (req, res) => {
  try {
    const result = await LoginOtpService.verifyOtp(req, req.body);
    const status = result.status || (result.success ? 200 : 401);
    delete result.status;
    return res.status(status).json(result);
  } catch (error) {
    console.error('❌ [local-auth] otp/verify error:', error);
    return res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

module.exports = router;
