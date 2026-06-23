// backend/routes/tenant-api-keys.js
// TenantAdmin/SysAdmin mints / lists / revokes a tenant-level "Website Integration" API key.
// Unlike agent-api-keys, these keys are AgentId = NULL (shared website) with Scope = 'website-integration'.
// Routing the inbound submission to the right agent stays dynamic (lookup by name/code).
// The full key is shown exactly once (on creation); only a SHA-256 hash is stored.
// Every query is filtered by TenantId (from req.user.TenantId / req.tenantId).

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getPool, sql } = require('../config/database');
const { authorize } = require('../middleware/auth');

const ROLES = ['TenantAdmin', 'SysAdmin'];
const SCOPE = 'website-integration';

function getTenantId(req) {
  return req.tenantId || req.user.TenantId;
}

/**
 * POST /api/tenant-api-keys
 * Mint a tenant-level website-integration key. Returns the full key once.
 */
router.post('/', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ success: false, message: 'Tenant context required.' });

    const fullKey = `sk_live_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex');
    const partialKey = fullKey.slice(-4);
    const apiKeyId = crypto.randomUUID();
    const keyName = (req.body && req.body.keyName) || 'Website Integration key';

    const r = pool.request();
    r.input('apiKeyId', sql.UniqueIdentifier, apiKeyId);
    r.input('tenantId', sql.UniqueIdentifier, tenantId);
    r.input('keyName', sql.NVarChar, keyName);
    r.input('keyHash', sql.NVarChar, keyHash);
    r.input('partialKey', sql.NVarChar, partialKey);
    r.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
    r.input('scope', sql.NVarChar, SCOPE);
    await r.query(`
      INSERT INTO oe.TenantApiKeys
        (ApiKeyId, TenantId, KeyName, KeyHash, PartialKey, Status, CreatedBy, CreatedDate, AgentId, Scope)
      VALUES
        (@apiKeyId, @tenantId, @keyName, @keyHash, @partialKey, 'active', @createdBy, GETUTCDATE(), NULL, @scope)
    `);

    // The full key is returned ONLY here and never stored in plaintext.
    return res.status(201).json({
      success: true,
      data: { apiKeyId, key: fullKey, partialKey, keyName },
      message: 'Save this key now — it will not be shown again.',
    });
  } catch (err) {
    console.error('❌ [tenant-api-keys] create error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create API key' });
  }
});

/**
 * GET /api/tenant-api-keys
 * List this tenant's website-integration keys (never returns the secret/hash).
 */
router.get('/', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    if (!tenantId) return res.json({ success: true, data: [] });

    const r = pool.request();
    r.input('tenantId', sql.UniqueIdentifier, tenantId);
    r.input('scope', sql.NVarChar, SCOPE);
    const result = await r.query(`
      SELECT ApiKeyId, KeyName, PartialKey, Status, LastUsedDate, CreatedDate
      FROM oe.TenantApiKeys
      WHERE TenantId = @tenantId AND Scope = @scope
      ORDER BY CreatedDate DESC
    `);

    const data = (result.recordset || []).map((row) => ({
      apiKeyId: row.ApiKeyId,
      keyName: row.KeyName,
      partialKey: row.PartialKey,
      status: row.Status,
      lastUsedDate: row.LastUsedDate,
      createdDate: row.CreatedDate,
    }));
    return res.json({ success: true, data });
  } catch (err) {
    console.error('❌ [tenant-api-keys] list error:', err);
    return res.status(500).json({ success: false, message: 'Failed to list API keys' });
  }
});

/**
 * DELETE /api/tenant-api-keys/:id
 * Revoke one of this tenant's website-integration keys.
 */
router.delete('/:id', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(403).json({ success: false, message: 'Tenant context required.' });

    const r = pool.request();
    r.input('apiKeyId', sql.UniqueIdentifier, req.params.id);
    r.input('tenantId', sql.UniqueIdentifier, tenantId);
    r.input('scope', sql.NVarChar, SCOPE);
    const result = await r.query(`
      UPDATE oe.TenantApiKeys SET Status = 'revoked'
      WHERE ApiKeyId = @apiKeyId AND TenantId = @tenantId AND Scope = @scope
    `);
    if ((result.rowsAffected?.[0] || 0) === 0) {
      return res.status(404).json({ success: false, message: 'Key not found' });
    }
    return res.json({ success: true, message: 'Key revoked' });
  } catch (err) {
    console.error('❌ [tenant-api-keys] revoke error:', err);
    return res.status(500).json({ success: false, message: 'Failed to revoke API key' });
  }
});

module.exports = router;
