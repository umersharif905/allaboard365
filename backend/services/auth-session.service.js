'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../config/database');
const UserRolesService = require('./shared/user-roles.service');

const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY || '1h';
const PERSISTENT_SESSION_DAYS = parseInt(process.env.PERSISTENT_SESSION_DAYS || '90', 10);
const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Create UserSessions row and return access + refresh JWTs (mobile: persistentSession=true).
 */
async function createSessionTokensForUser(user, { userAgent = null, persistentSession = true } = {}) {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not set');
  }

  const roles = await UserRolesService.getUserRoleNames(user.UserId);
  if (!roles || roles.length === 0) {
    const err = new Error('User has no roles assigned');
    err.code = 'NO_ROLES';
    throw err;
  }

  const sessionStartedAt = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  const pool = await getPool();

  const insertSessionRequest = pool.request();
  insertSessionRequest.input('sessionId', sql.UniqueIdentifier, sessionId);
  insertSessionRequest.input('userId', sql.UniqueIdentifier, user.UserId);
  insertSessionRequest.input('userAgent', sql.NVarChar, userAgent);
  await insertSessionRequest.query(`
    INSERT INTO oe.UserSessions (SessionId, UserId, UserAgent)
    VALUES (@sessionId, @userId, @userAgent)
  `);

  const accessPayload = {
    userId: user.UserId,
    email: user.Email,
    tenantId: user.TenantId,
    roles,
    sessionStartedAt,
  };
  const accessToken = jwt.sign(accessPayload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });

  const refreshPayload = {
    userId: user.UserId,
    email: user.Email,
    sessionStartedAt,
    sessionId,
    persistentSession: persistentSession === true,
    type: 'refresh',
  };
  const refreshToken = jwt.sign(refreshPayload, JWT_SECRET, {
    expiresIn: persistentSession ? `${PERSISTENT_SESSION_DAYS}d` : '12h',
  });

  await pool.request()
    .input('userId', sql.UniqueIdentifier, user.UserId)
    .query(`UPDATE oe.Users SET LastLoginDate = GETDATE() WHERE UserId = @userId`);

  return {
    accessToken,
    refreshToken,
    roles,
    tenantId: user.TenantId != null ? String(user.TenantId) : '',
    userId: String(user.UserId),
    email: user.Email,
    firstName: user.FirstName || undefined,
    lastName: user.LastName || undefined,
    phoneNumber: user.PhoneNumber || undefined,
  };
}

module.exports = {
  createSessionTokensForUser,
};
