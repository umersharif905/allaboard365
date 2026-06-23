// backend/routes/prospect-sources.js
// CRUD for agent-owned prospect sources (website / landing / api).
// Tenant-scoped via requireTenantAccess in app.js.

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize } = require('../middleware/auth');
const svc = require('../services/prospectSource.service');

const ROLES = ['Agent', 'AgencyOwner', 'TenantAdmin', 'SysAdmin'];

function getTenantId(req) {
  return req.tenantId || req.user.TenantId;
}

async function getAgentCtx(pool, req) {
  const r = pool.request();
  r.input('userId', sql.UniqueIdentifier, req.user.UserId);
  r.input('tenantId', sql.UniqueIdentifier, getTenantId(req));
  const res = await r.query(`
    SELECT TOP 1 AgentId, AgentCode FROM oe.Agents
    WHERE UserId = @userId AND TenantId = @tenantId
    ORDER BY CASE WHEN Status='Active' THEN 0 ELSE 1 END`);
  return res.recordset[0] || null;
}

async function getMarketingConfig(pool, tenantId) {
  const r = pool.request();
  r.input('tenantId', sql.UniqueIdentifier, tenantId);
  const res = await r.query(`SELECT AdvancedSettings FROM oe.Tenants WHERE TenantId=@tenantId`);
  let adv = {};
  try {
    adv = res.recordset[0]?.AdvancedSettings ? JSON.parse(res.recordset[0].AdvancedSettings) : {};
  } catch {
    adv = {};
  }
  const idParam = adv.marketingLink?.idParam || 'id';
  const destinations = Array.isArray(adv.marketingLink?.destinations)
    ? adv.marketingLink.destinations
    : [];
  return { idParam, destinations };
}

/**
 * GET /api/prospect-sources
 * List the current agent's active sources with computed public links.
 */
router.get('/', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const agent = await getAgentCtx(pool, req);
    if (!agent) return res.json({ success: true, data: [] });
    const { idParam, destinations } = await getMarketingConfig(pool, tenantId);

    // Ensure the agent's default (plain ?id=<AgentCode>) sources exist so legacy
    // / name-only leads attribute to a real source. Never block the list.
    try {
      await svc.ensureDefaultSources(pool, {
        tenantId,
        agentId: agent.AgentId,
        agentCode: agent.AgentCode,
        idParam,
        destinations,
        createdBy: req.user.UserId,
      });
    } catch (ensureErr) {
      console.error('❌ [prospect-sources] ensureDefaultSources error:', ensureErr);
    }

    const rows = await svc.listSources(pool, { tenantId, agentId: agent.AgentId });
    const data = rows.map((s) => ({
      sourceId: s.SourceId,
      name: s.Name,
      tag: s.Tag,
      type: s.Type,
      destinationUrl: s.DestinationUrl,
      linkCode: s.LinkCode,
      link: (s.Type === 'website' || s.Type === 'landing')
        ? svc.buildPublicLink(s.DestinationUrl, idParam, agent.AgentCode, s.LinkCode)
        : null,
      color: s.Color,
      isDefault: !!s.IsDefault,
      apiPartialKey: s.ApiPartialKey || null,
      leadCount: s.LeadCount,
      enrolledCount: s.EnrolledCount,
      createdDate: s.CreatedDate,
    }));
    return res.json({ success: true, data });
  } catch (err) {
    console.error('❌ [prospect-sources] list error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load sources' });
  }
});

/**
 * POST /api/prospect-sources
 * Create a new source for the current agent.
 * For type=website|landing: looks up the matching tenant destination URL automatically.
 * For type=api: mints a lead-ingest API key (returned once).
 */
router.post('/', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const agent = await getAgentCtx(pool, req);
    if (!agent) return res.status(403).json({ success: false, message: 'Agent profile required.' });

    const { name, tag, type, destinationLabel, color } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required.' });
    }
    if (!svc.SOURCE_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid type.' });
    }

    const { idParam, destinations } = await getMarketingConfig(pool, tenantId);
    let destinationUrl = null;
    if (type === 'website' || type === 'landing') {
      const dest =
        destinations.find((d) => d.type === type && (!destinationLabel || d.label === destinationLabel)) ||
        destinations.find((d) => d.type === type);
      if (!dest) {
        return res.status(400).json({ success: false, message: `No ${type} destination configured for this tenant.` });
      }
      destinationUrl = dest.url;
    }

    const result = await svc.createSource(pool, {
      tenantId,
      agentId: agent.AgentId,
      agentCode: agent.AgentCode,
      idParam,
      name: name.trim(),
      tag,
      type,
      destinationUrl,
      createdBy: req.user.UserId,
      color: color || null,
    });
    return res.status(201).json({ success: true, data: result });
  } catch (err) {
    console.error('❌ [prospect-sources] create error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create source' });
  }
});

/**
 * PATCH /api/prospect-sources/:id
 * Update name, tag, or destinationUrl for an existing source.
 */
router.patch('/:id', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const agent = await getAgentCtx(pool, req);
    if (!agent) return res.status(403).json({ success: false, message: 'Agent profile required.' });

    const { name, tag, destinationUrl, color } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Name is required.' });
    const ok = await svc.updateSource(pool, {
      tenantId,
      agentId: agent.AgentId,
      sourceId: req.params.id,
      name: name.trim(),
      tag,
      destinationUrl,
      color: color || null,
    });
    if (!ok) return res.status(404).json({ success: false, message: 'Source not found.' });
    return res.json({ success: true });
  } catch (err) {
    console.error('❌ [prospect-sources] update error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update source' });
  }
});

/**
 * DELETE /api/prospect-sources/:id
 * Archive a source (sets Status = 'archived', revokes any linked API key).
 */
router.delete('/:id', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const agent = await getAgentCtx(pool, req);
    if (!agent) return res.status(403).json({ success: false, message: 'Agent profile required.' });

    // Default sources back the plain ?id=<AgentCode> link — they cannot be removed.
    const dchk = pool.request();
    dchk.input('sourceId', sql.UniqueIdentifier, req.params.id);
    dchk.input('tenantId', sql.UniqueIdentifier, tenantId);
    dchk.input('agentId', sql.UniqueIdentifier, agent.AgentId);
    const dres = await dchk.query(`
      SELECT IsDefault FROM oe.ProspectSources
      WHERE SourceId=@sourceId AND TenantId=@tenantId AND AgentId=@agentId`);
    if (dres.recordset[0] && dres.recordset[0].IsDefault) {
      return res.status(400).json({ success: false, message: 'Default sources cannot be removed.' });
    }

    const ok = await svc.archiveSource(pool, {
      tenantId,
      agentId: agent.AgentId,
      sourceId: req.params.id,
    });
    if (!ok) return res.status(404).json({ success: false, message: 'Source not found.' });
    return res.json({ success: true });
  } catch (err) {
    console.error('❌ [prospect-sources] delete error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete source' });
  }
});

module.exports = router;
