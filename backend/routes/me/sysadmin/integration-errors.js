/**
 * GET  /api/me/sysadmin/integration-errors?page=&limit=&category=&includeResolved=
 * POST /api/me/sysadmin/integration-errors/:id/resolve
 * POST /api/me/sysadmin/integration-errors/:id/unresolve
 * GET  /api/me/sysadmin/integration-errors/notification-settings
 * PUT  /api/me/sysadmin/integration-errors/notification-settings
 */
const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const {
  listIntegrationErrors,
  setIntegrationErrorResolved
} = require('../../../services/integrationErrorService');
const { getPool, sql } = require('../../../config/database');

// Mirrors the key used by the digest job so both sides stay in sync without a cross-service import.
const NOTIFICATION_SETTING_KEY = 'system.integration_error_notification_emails';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseRecipients(raw) {
  const parts = String(raw || '')
    .split(/[,;\s]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = [];
  const invalid = [];
  for (const p of parts) {
    if (EMAIL_RE.test(p)) valid.push(p);
    else invalid.push(p);
  }
  return { valid, invalid };
}

router.use(authorize(['SysAdmin']));

router.get('/', async (req, res) => {
  try {
    const { page, limit, category, includeResolved } = req.query;
    const data = await listIntegrationErrors({ page, limit, category, includeResolved });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('integration-errors list:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load integration errors',
      error: { message: error.message, code: 'INTEGRATION_ERRORS_LIST' }
    });
  }
});

// POST /:id/resolve and /:id/unresolve share the same handler with an inverted flag so the client
// surface stays RESTful ("button → endpoint") without adding a body-required PATCH shape.
async function handleSetResolved(req, res, resolved) {
  try {
    const userId = req.user?.userId || req.user?.UserId || req.user?.id || null;
    const result = await setIntegrationErrorResolved(req.params.id, resolved, userId);
    if (!result.updated) {
      return res.status(404).json({
        success: false,
        message: 'Integration error not found',
        error: { code: 'INTEGRATION_ERROR_NOT_FOUND' }
      });
    }
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error(`integration-errors ${resolved ? 'resolve' : 'unresolve'}:`, error);
    const msg = String(error.message || '');
    // Migration-required hint so the UI can surface the fix instead of looking broken.
    if (msg.includes('Invalid column name') && msg.includes('Resolved')) {
      return res.status(500).json({
        success: false,
        message:
          'Resolution columns missing — run sql-changes/2026-04-08-system-integration-errors-resolution.sql',
        error: { code: 'INTEGRATION_ERRORS_MIGRATION_REQUIRED' }
      });
    }
    return res.status(500).json({
      success: false,
      message: resolved ? 'Failed to mark resolved' : 'Failed to mark unresolved',
      error: { message: error.message, code: 'INTEGRATION_ERRORS_RESOLVE' }
    });
  }
}

router.post('/:id/resolve', (req, res) => handleSetResolved(req, res, true));
router.post('/:id/unresolve', (req, res) => handleSetResolved(req, res, false));

// Email recipients for the every-15-min digest. Exposed here (rather than only through the generic
// admin system-settings route) so the Integration Errors page can edit them inline via a modal
// without bouncing users to a different screen. Source of truth stays oe.SystemSettings.
router.get('/notification-settings', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('key', sql.NVarChar(128), NOTIFICATION_SETTING_KEY)
      .query(`SELECT SettingValue FROM oe.SystemSettings WHERE SettingKey = @key`);
    const raw = result.recordset?.[0]?.SettingValue || '';
    const { valid, invalid } = parseRecipients(raw);
    return res.json({
      success: true,
      data: {
        key: NOTIFICATION_SETTING_KEY,
        recipients: raw,
        validEmails: valid,
        invalidEmails: invalid
      }
    });
  } catch (error) {
    console.error('integration-errors notification-settings get:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load notification recipients',
      error: { message: error.message, code: 'NOTIFICATION_SETTINGS_LOAD' }
    });
  }
});

router.put('/notification-settings', async (req, res) => {
  try {
    const incoming = typeof req.body?.recipients === 'string' ? req.body.recipients : '';
    const { valid, invalid } = parseRecipients(incoming);
    if (invalid.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Invalid email${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}`,
        error: { code: 'NOTIFICATION_SETTINGS_INVALID_EMAIL', invalidEmails: invalid }
      });
    }
    const normalized = valid.join(', ');
    const userId = req.user?.userId || req.user?.UserId || req.user?.id || null;
    const pool = await getPool();
    // UPSERT so this endpoint works even if the row wasn't seeded yet (fresh envs, dev databases).
    const updateResult = await pool
      .request()
      .input('key', sql.NVarChar(128), NOTIFICATION_SETTING_KEY)
      .input('value', sql.NVarChar(sql.MAX), normalized)
      .input('userId', sql.UniqueIdentifier, userId)
      .query(`
        UPDATE oe.SystemSettings
        SET SettingValue = @value, ModifiedDate = GETDATE(), ModifiedBy = @userId
        WHERE SettingKey = @key
      `);
    if ((updateResult.rowsAffected?.[0] || 0) === 0) {
      await pool
        .request()
        .input('key', sql.NVarChar(128), NOTIFICATION_SETTING_KEY)
        .input('value', sql.NVarChar(sql.MAX), normalized)
        .input('userId', sql.UniqueIdentifier, userId)
        .query(`
          INSERT INTO oe.SystemSettings (SettingKey, SettingValue, SettingType, Category, Description, IsReadOnly, ModifiedBy)
          VALUES (@key, @value, N'text', N'notifications',
            N'Recipients for the every-15-minute integration error digest (comma-separated).', 0, @userId)
        `);
    }
    return res.json({
      success: true,
      data: { recipients: normalized, validEmails: valid, invalidEmails: [] }
    });
  } catch (error) {
    console.error('integration-errors notification-settings put:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to save notification recipients',
      error: { message: error.message, code: 'NOTIFICATION_SETTINGS_SAVE' }
    });
  }
});

module.exports = router;
