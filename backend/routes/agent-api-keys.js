// backend/routes/agent-api-keys.js
// An agent mints / lists / revokes their own API key for the lead-ingest endpoint.
// The full key is shown exactly once (on creation); only a SHA-256 hash is stored.
// Tenant-scoped via requireTenantAccess in app.js.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getPool, sql } = require('../config/database');
const { authorize } = require('../middleware/auth');

const ROLES = ['Agent', 'AgencyOwner', 'TenantAdmin', 'SysAdmin'];
const SCOPE = 'lead-ingest';

function getTenantId(req) {
  return req.tenantId || req.user.TenantId;
}

async function getMyAgentId(pool, userId) {
  const r = pool.request();
  r.input('userId', sql.UniqueIdentifier, userId);
  const result = await r.query(`SELECT AgentId FROM oe.Agents WHERE UserId = @userId AND Status = 'Active'`);
  return result.recordset[0]?.AgentId || null;
}

/**
 * POST /api/agent-api-keys
 * Generate a new lead-ingest key for the current agent. Returns the full key once.
 */
router.post('/', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const agentId = await getMyAgentId(pool, req.user.UserId);
    if (!agentId) return res.status(403).json({ success: false, message: 'Agent profile required.' });

    const fullKey = `sk_live_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex');
    const partialKey = fullKey.slice(-4);
    const apiKeyId = crypto.randomUUID();
    const keyName = (req.body && req.body.name) || 'Lead ingest key';

    const r = pool.request();
    r.input('apiKeyId', sql.UniqueIdentifier, apiKeyId);
    r.input('tenantId', sql.UniqueIdentifier, tenantId);
    r.input('keyName', sql.NVarChar, keyName);
    r.input('keyHash', sql.NVarChar, keyHash);
    r.input('partialKey', sql.NVarChar, partialKey);
    r.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
    r.input('agentId', sql.UniqueIdentifier, agentId);
    r.input('scope', sql.NVarChar, SCOPE);
    await r.query(`
      INSERT INTO oe.TenantApiKeys
        (ApiKeyId, TenantId, KeyName, KeyHash, PartialKey, Status, CreatedBy, CreatedDate, AgentId, Scope)
      VALUES
        (@apiKeyId, @tenantId, @keyName, @keyHash, @partialKey, 'active', @createdBy, GETUTCDATE(), @agentId, @scope)
    `);

    // The full key is returned ONLY here and never stored in plaintext.
    return res.status(201).json({
      success: true,
      data: { apiKeyId, name: keyName, partialKey, key: fullKey, scope: SCOPE },
      message: 'Save this key now — it will not be shown again.',
    });
  } catch (err) {
    console.error('❌ [agent-api-keys] create error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create API key' });
  }
});

/**
 * GET /api/agent-api-keys
 * List the current agent's keys (never returns the secret).
 */
router.get('/', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const agentId = await getMyAgentId(pool, req.user.UserId);
    if (!agentId) return res.json({ success: true, data: [] });

    const r = pool.request();
    r.input('tenantId', sql.UniqueIdentifier, tenantId);
    r.input('agentId', sql.UniqueIdentifier, agentId);
    const result = await r.query(`
      SELECT ApiKeyId, KeyName, PartialKey, Status, Scope, CreatedDate, LastUsedDate
      FROM oe.TenantApiKeys
      WHERE TenantId = @tenantId AND AgentId = @agentId
      ORDER BY CreatedDate DESC
    `);
    return res.json({ success: true, data: result.recordset || [] });
  } catch (err) {
    console.error('❌ [agent-api-keys] list error:', err);
    return res.status(500).json({ success: false, message: 'Failed to list API keys' });
  }
});

/**
 * DELETE /api/agent-api-keys/:id
 * Revoke one of the current agent's keys.
 */
router.delete('/:id', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const agentId = await getMyAgentId(pool, req.user.UserId);
    if (!agentId) return res.status(403).json({ success: false, message: 'Agent profile required.' });

    const r = pool.request();
    r.input('apiKeyId', sql.UniqueIdentifier, req.params.id);
    r.input('tenantId', sql.UniqueIdentifier, tenantId);
    r.input('agentId', sql.UniqueIdentifier, agentId);
    const result = await r.query(`
      UPDATE oe.TenantApiKeys SET Status = 'revoked'
      WHERE ApiKeyId = @apiKeyId AND TenantId = @tenantId AND AgentId = @agentId
    `);
    if ((result.rowsAffected?.[0] || 0) === 0) {
      return res.status(404).json({ success: false, message: 'Key not found' });
    }
    return res.json({ success: true, message: 'Key revoked' });
  } catch (err) {
    console.error('❌ [agent-api-keys] revoke error:', err);
    return res.status(500).json({ success: false, message: 'Failed to revoke API key' });
  }
});

module.exports = router;
