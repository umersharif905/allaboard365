// backend/routes/me/tenant-admin/user-sessions.js
// List and revoke user sessions (TenantAdmin + SysAdmin; TenantAdmin scoped to same tenant)

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize, getUserRoles } = require('../../../middleware/auth');

/**
 * Ensure target userId belongs to caller's tenant (TenantAdmin) or allow any (SysAdmin)
 */
async function ensureTenantAccess(req, targetUserId) {
  const isSysAdmin = getUserRoles(req.user).includes('SysAdmin');
  if (isSysAdmin) return true;
  const pool = await getPool();
  const r = pool.request();
  r.input('userId', sql.UniqueIdentifier, targetUserId);
  const result = await r.query(`
    SELECT TenantId FROM oe.Users WHERE UserId = @userId
  `);
  if (result.recordset.length === 0) return false;
  const targetTenantId = result.recordset[0].TenantId;
  const callerTenantId = req.tenantId || req.user?.TenantId;
  return targetTenantId && callerTenantId && String(targetTenantId) === String(callerTenantId);
}

/**
 * GET /api/me/tenant-admin/user-sessions?userId=...
 * List sessions for a user. TenantAdmin: only users in their tenant.
 */
router.get('/', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId query parameter is required' });
    }
    const allowed = await ensureTenantAccess(req, userId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied to this user' });
    }
    const pool = await getPool();
    const request = pool.request();
    request.input('userId', sql.UniqueIdentifier, userId);
    let result;
    try {
      result = await request.query(`
        SELECT 
          SessionId,
          UserId,
          CreatedAt,
          LastActivityAt,
          UserAgent,
          RevokedAt
        FROM oe.UserSessions
        WHERE UserId = @userId AND RevokedAt IS NULL
        ORDER BY LastActivityAt DESC
      `);
    } catch (tableErr) {
      if (tableErr.message && tableErr.message.includes('UserSessions')) {
        return res.json({ success: true, data: [] });
      }
      throw tableErr;
    }
    const sessions = (result.recordset || []).map((row) => ({
      sessionId: row.SessionId,
      userId: row.UserId,
      createdAt: row.CreatedAt,
      lastActivityAt: row.LastActivityAt,
      userAgent: row.UserAgent || null
    }));
    res.json({ success: true, data: sessions });
  } catch (error) {
    console.error('❌ [user-sessions] GET error:', error);
    res.status(500).json({ success: false, message: 'Failed to list sessions' });
  }
});

/**
 * POST /api/me/tenant-admin/user-sessions/revoke
 * Body: { userId, sessionId? }. If sessionId omitted, revoke all sessions for user.
 */
router.post('/revoke', authorize(['TenantAdmin', 'SysAdmin']), async (req, res) => {
  try {
    const { userId, sessionId } = req.body || {};
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required' });
    }
    const allowed = await ensureTenantAccess(req, userId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied to this user' });
    }
    const pool = await getPool();
    const request = pool.request();
    request.input('userId', sql.UniqueIdentifier, userId);
    if (sessionId) {
      request.input('sessionId', sql.UniqueIdentifier, sessionId);
      const updateResult = await request.query(`
        UPDATE oe.UserSessions
        SET RevokedAt = GETUTCDATE()
        WHERE UserId = @userId AND SessionId = @sessionId AND RevokedAt IS NULL
      `);
      const revoked = (updateResult.rowsAffected && updateResult.rowsAffected[0]) || 0;
      return res.json({ success: true, revoked: revoked > 0, message: revoked > 0 ? 'Session revoked' : 'Session not found or already revoked' });
    }
    const updateResult = await request.query(`
      UPDATE oe.UserSessions
      SET RevokedAt = GETUTCDATE()
      WHERE UserId = @userId AND RevokedAt IS NULL
    `);
    const revoked = (updateResult.rowsAffected && updateResult.rowsAffected[0]) || 0;
    res.json({ success: true, revoked: true, count: revoked, message: `Revoked ${revoked} session(s)` });
  } catch (error) {
    console.error('❌ [user-sessions] POST revoke error:', error);
    res.status(500).json({ success: false, message: 'Failed to revoke session(s)' });
  }
});

module.exports = router;
