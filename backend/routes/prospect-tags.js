// backend/routes/prospect-tags.js
// Prospect tags (agency-shared, colored). Agents create tags shared within their agency;
// admins create tenant-wide tags (AgencyId NULL). Listing returns the tags visible to the
// caller. Tenant-scoped via requireTenantAccess in app.js.

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize, getUserRoles } = require('../middleware/auth');
const prospectService = require('../services/prospect.service');

const ROLES = ['Agent', 'AgencyOwner', 'TenantAdmin', 'SysAdmin'];

function getTenantId(req) {
  return req.tenantId || req.user.TenantId;
}

async function getMyAgentContext(pool, userId) {
  const r = pool.request();
  r.input('userId', sql.UniqueIdentifier, userId);
  const result = await r.query(`SELECT AgentId, AgencyId FROM oe.Agents WHERE UserId = @userId AND Status = 'Active'`);
  return result.recordset[0] || null;
}

/**
 * GET /api/prospect-tags
 * Tags visible to the caller (tenant-wide + own agency for agents; all for admins).
 */
router.get('/', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const roles = getUserRoles(req.user) || [];
    const isAdmin = roles.includes('SysAdmin') || roles.includes('TenantAdmin');
    const me = isAdmin ? null : await getMyAgentContext(pool, req.user.UserId);
    const tags = await prospectService.listTags(pool, {
      tenantId,
      agencyId: me ? me.AgencyId : null,
      isAdmin,
    });
    return res.json({ success: true, data: tags });
  } catch (err) {
    console.error('❌ [prospect-tags] list error:', err);
    return res.status(500).json({ success: false, message: 'Failed to list tags' });
  }
});

/**
 * POST /api/prospect-tags
 * Create (or reuse) a tag. Body: { name, color }. Agents scope it to their agency;
 * admins create a tenant-wide tag.
 */
router.post('/', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const roles = getUserRoles(req.user) || [];
    const { name, color } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Tag name is required.' });
    }

    const isAdmin = roles.includes('SysAdmin') || roles.includes('TenantAdmin');
    let agencyId = null;
    if (!isAdmin) {
      const me = await getMyAgentContext(pool, req.user.UserId);
      agencyId = me ? me.AgencyId : null;
    }

    const tag = await prospectService.createTag(pool, {
      tenantId, agencyId, name, color, createdBy: req.user.UserId,
    });
    return res.status(201).json({ success: true, data: tag });
  } catch (err) {
    console.error('❌ [prospect-tags] create error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create tag' });
  }
});

/**
 * DELETE /api/prospect-tags/:id
 * Delete a tag (and its assignments). Admins may delete any tenant tag; an agent may
 * only delete a tag shared within their own agency.
 */
router.delete('/:id', authorize(ROLES), async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = getTenantId(req);
    const roles = getUserRoles(req.user) || [];
    const isAdmin = roles.includes('SysAdmin') || roles.includes('TenantAdmin');

    const tag = await prospectService.getTag(pool, { tagId: req.params.id, tenantId });
    if (!tag) return res.status(404).json({ success: false, message: 'Tag not found' });

    if (!isAdmin) {
      const me = await getMyAgentContext(pool, req.user.UserId);
      const myAgency = me ? me.AgencyId : null;
      // Agents can only delete tags in their own agency scope, never tenant-wide tags.
      if (!tag.AgencyId || String(tag.AgencyId) !== String(myAgency)) {
        return res.status(403).json({ success: false, message: 'You cannot delete this tag.' });
      }
    }

    await prospectService.deleteTag(pool, { tagId: req.params.id, tenantId });
    return res.json({ success: true, message: 'Tag deleted' });
  } catch (err) {
    console.error('❌ [prospect-tags] delete error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete tag' });
  }
});

module.exports = router;
