// backend/routes/me/notification-preferences.js
// Per-agent notification preferences for the current user.
// Currently exposes the "email me when I get a new prospect" opt-out backed by
// oe.Agents.NotifyNewProspectEmail (BIT NULL; NULL/1 = on, 0 = off).
//
// Mounted under /api/me (authenticated). The agent is resolved from req.user.UserId,
// scoped to the user's tenant. DEFENSIVE: if the NotifyNewProspectEmail column has not
// been migrated yet, GET reports `true` (default ON, mirroring the notify hook) and
// PUT responds with a clear message instead of erroring.

// NOTE: Authentication is applied by the parent /api/me mount in app.js (app.use('/api/me', authenticate, …)),
// so req.user is already populated here for any authenticated user (the current agent).

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');

function getTenantId(req) {
  return req.tenantId || req.user.TenantId;
}

// SQL Server error number for "Invalid column name" — used to detect a pre-migration DB.
function isMissingColumnError(err) {
  return err && (err.number === 207 || /invalid column name/i.test(err.message || ''));
}

/**
 * GET /api/me/notification-preferences
 * Returns the current agent's prospect-notification preference. NULL is treated as ON.
 */
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);

    const r = pool.request();
    r.input('userId', sql.UniqueIdentifier, req.user.UserId);
    r.input('tenantId', sql.UniqueIdentifier, tenantId);
    const result = await r.query(`
      SELECT TOP 1 NotifyNewProspectEmail
      FROM oe.Agents
      WHERE UserId = @userId AND TenantId = @tenantId
    `);

    const raw = result.recordset[0]?.NotifyNewProspectEmail;
    // No agent row, or NULL value → default ON.
    const notifyNewProspectEmail = raw === false || raw === 0 ? false : true;
    return res.json({ success: true, data: { notifyNewProspectEmail } });
  } catch (err) {
    if (isMissingColumnError(err)) {
      // Pre-migration DB: default ON so the flow works everywhere.
      return res.json({ success: true, data: { notifyNewProspectEmail: true } });
    }
    console.error('❌ [notification-preferences] get error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load notification preferences' });
  }
});

/**
 * PUT /api/me/notification-preferences
 * Body: { notifyNewProspectEmail: boolean }
 * Updates the current agent's preference (scoped to TenantId + the agent's UserId).
 */
router.put('/', async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const notifyNewProspectEmail = !!(req.body && req.body.notifyNewProspectEmail);

    const r = pool.request();
    r.input('userId', sql.UniqueIdentifier, req.user.UserId);
    r.input('tenantId', sql.UniqueIdentifier, tenantId);
    r.input('notify', sql.Bit, notifyNewProspectEmail);
    const result = await r.query(`
      UPDATE oe.Agents
      SET NotifyNewProspectEmail = @notify
      WHERE UserId = @userId AND TenantId = @tenantId
    `);

    if ((result.rowsAffected?.[0] || 0) === 0) {
      return res.status(404).json({ success: false, message: 'Agent profile not found.' });
    }
    return res.json({ success: true, data: { notifyNewProspectEmail } });
  } catch (err) {
    if (isMissingColumnError(err)) {
      // Pre-migration DB: tell the caller clearly instead of 500ing.
      return res.status(409).json({
        success: false,
        message: 'Notification preferences are not available yet — a database update is pending.',
      });
    }
    console.error('❌ [notification-preferences] update error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update notification preferences' });
  }
});

module.exports = router;
