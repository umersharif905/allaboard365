/**
 * Agency-scoped resource library administration (Pattern 1: /api/me/agent/...).
 * Mounted at /api/me/agent/agencies/:agencyId
 */
const express = require('express');
const router = express.Router({ mergeParams: true });
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const agencyLib = require('../../../services/shared/agency-marketing-library.service');
const agencyAdmins = require('../../../utils/agencyAdmins');

const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

router.use(authorize(['Agent']));

function tenantIdFromReq(req) {
  return req.tenantId || req.user?.TenantId || null;
}

async function assertAgencyAdmin(pool, req, agencyId) {
  const tid = tenantIdFromReq(req);
  if (!tid || !uuidRe.test(String(agencyId))) {
    const e = new Error('Invalid context');
    e.statusCode = 400;
    throw e;
  }
  const profile = await agencyLib.getAgentProfileForUser(pool, req.user.UserId);
  if (!profile?.AgentId) {
    const e = new Error('Agent profile not found');
    e.statusCode = 403;
    throw e;
  }
  const agency = await agencyLib.verifyAgencyInTenant(pool, tid, agencyId);
  if (!agency) {
    const e = new Error('Agency not found');
    e.statusCode = 404;
    throw e;
  }
  const ok = await agencyAdmins.isAgencyAdmin(pool, agencyId, profile.AgentId);
  if (!ok) {
    const e = new Error('Agency admin access required');
    e.statusCode = 403;
    throw e;
  }
  return { tenantId: tid, agentId: profile.AgentId, agency };
}

function pickAgencyFolderBody(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const o = {};
  if (Object.prototype.hasOwnProperty.call(b, 'name')) o.name = b.name;
  if (Object.prototype.hasOwnProperty.call(b, 'description')) o.description = b.description;
  if (Object.prototype.hasOwnProperty.call(b, 'hideFromAgents')) o.hideFromAgents = b.hideFromAgents;
  return o;
}

function pickCreateAgencyResourceBody(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const o = {};
  const keys = [
    'folderId',
    'title',
    'description',
    'resourceType',
    'externalUrl',
    'fileId',
    'fileName',
    'storedFileName',
    'fileUrl',
    'mimeType',
    'fileSize'
  ];
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k];
  }
  return o;
}

function pickAgencyResourcePatch(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(b, 'title')) patch.title = b.title;
  if (Object.prototype.hasOwnProperty.call(b, 'description')) patch.description = b.description;
  if (Object.prototype.hasOwnProperty.call(b, 'folderId')) patch.folderId = b.folderId;
  return patch;
}

/** PATCH /library-settings — toggle UseCustomResourceLibrary */
router.patch('/library-settings', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const pool = await getPool();
    const { tenantId } = await assertAgencyAdmin(pool, req, agencyId);
    const raw = req.body && typeof req.body === 'object' ? req.body : {};
    if (!Object.prototype.hasOwnProperty.call(raw, 'useCustomResourceLibrary')) {
      return res.status(400).json({ success: false, message: 'useCustomResourceLibrary is required' });
    }
    const row = await agencyLib.updateAgencyLibrarySetting(
      pool,
      agencyId,
      tenantId,
      raw.useCustomResourceLibrary === true
    );
    if (!row) return res.status(404).json({ success: false, message: 'Agency not found' });
    res.json({
      success: true,
      data: {
        agencyId,
        useCustomResourceLibrary: Boolean(row.UseCustomResourceLibrary)
      }
    });
  } catch (e) {
    console.error('[agency-resource-library] PATCH library-settings', e);
    const code = e.statusCode || 500;
    res.status(code).json({ success: false, message: e.message || 'Update failed' });
  }
});

/** GET /marketing-resources/organization-catalog — read-only copy source (full tenant tree + org name) */
router.get('/marketing-resources/organization-catalog', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const pool = await getPool();
    await assertAgencyAdmin(pool, req, agencyId);
    const tenantId = tenantIdFromReq(req);
    const cat = await agencyLib.getOrganizationCatalogForCopy(pool, tenantId);
    res.json({ success: true, data: cat });
  } catch (e) {
    console.error('[agency-resource-library] GET organization-catalog', e);
    const code = e.statusCode || 500;
    res.status(code).json({ success: false, message: e.message || 'Failed to load catalog' });
  }
});

/** POST /marketing-resources/copy-from-organization */
router.post('/marketing-resources/copy-from-organization', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const pool = await getPool();
    const { tenantId } = await assertAgencyAdmin(pool, req, agencyId);
    const raw = req.body && typeof req.body === 'object' ? req.body : {};
    const folderIds = raw.folderIds;
    if (!Array.isArray(folderIds) || folderIds.length === 0) {
      return res.status(400).json({ success: false, message: 'folderIds array required' });
    }
    const tree = await agencyLib.copyFoldersFromOrganization(pool, agencyId, tenantId, req.user.UserId, folderIds);
    res.json({ success: true, data: { folders: tree } });
  } catch (e) {
    console.error('[agency-resource-library] POST copy-from-organization', e);
    const code = e.statusCode || 400;
    res.status(code).json({ success: false, message: e.message || 'Copy failed' });
  }
});

/** POST /marketing-folders */
router.post('/marketing-folders', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const pool = await getPool();
    const { tenantId } = await assertAgencyAdmin(pool, req, agencyId);
    const row = await agencyLib.createAgencyFolder(pool, agencyId, tenantId, req.user.UserId, pickAgencyFolderBody(req.body));
    res.status(201).json({ success: true, data: row });
  } catch (e) {
    console.error('[agency-resource-library] POST folder', e);
    const code = e.statusCode || 400;
    res.status(code).json({ success: false, message: e.message || 'Create failed' });
  }
});

/** PATCH /marketing-folders/reorder */
router.patch('/marketing-folders/reorder', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const pool = await getPool();
    const { tenantId } = await assertAgencyAdmin(pool, req, agencyId);
    const { orderedFolderIds } = req.body || {};
    const rows = await agencyLib.reorderAgencyFolders(pool, agencyId, tenantId, req.user.UserId, orderedFolderIds);
    res.json({ success: true, data: { folders: rows } });
  } catch (e) {
    console.error('[agency-resource-library] reorder folders', e);
    const code = e.statusCode || 400;
    res.status(code).json({ success: false, message: e.message || 'Reorder failed' });
  }
});

/** PATCH /marketing-folders/:folderId */
router.patch('/marketing-folders/:folderId', async (req, res) => {
  try {
    const { agencyId, folderId } = req.params;
    if (!uuidRe.test(folderId)) return res.status(400).json({ success: false, message: 'Invalid folder id' });
    const pool = await getPool();
    const { tenantId } = await assertAgencyAdmin(pool, req, agencyId);
    const row = await agencyLib.updateAgencyFolder(
      pool,
      agencyId,
      tenantId,
      req.user.UserId,
      folderId,
      pickAgencyFolderBody(req.body)
    );
    if (!row) return res.status(404).json({ success: false, message: 'Folder not found' });
    res.json({ success: true, data: row });
  } catch (e) {
    console.error('[agency-resource-library] PATCH folder', e);
    const code = e.statusCode || 400;
    res.status(code).json({ success: false, message: e.message || 'Update failed' });
  }
});

/** DELETE /marketing-folders/:folderId */
router.delete('/marketing-folders/:folderId', async (req, res) => {
  try {
    const { agencyId, folderId } = req.params;
    if (!uuidRe.test(folderId)) return res.status(400).json({ success: false, message: 'Invalid folder id' });
    const pool = await getPool();
    const { tenantId } = await assertAgencyAdmin(pool, req, agencyId);
    const ok = await agencyLib.deleteAgencyFolder(pool, agencyId, tenantId, req.user.UserId, folderId);
    if (!ok) return res.status(404).json({ success: false, message: 'Folder not found' });
    res.json({ success: true, message: 'Folder removed' });
  } catch (e) {
    console.error('[agency-resource-library] DELETE folder', e);
    const code = e.statusCode || 500;
    res.status(code).json({ success: false, message: e.message || 'Delete failed' });
  }
});

/** POST /marketing-resources — create resource */
router.post('/marketing-resources', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const pool = await getPool();
    const { tenantId } = await assertAgencyAdmin(pool, req, agencyId);
    const resourceId = await agencyLib.createAgencyResource(
      pool,
      agencyId,
      tenantId,
      req.user.UserId,
      pickCreateAgencyResourceBody(req.body)
    );
    res.status(201).json({ success: true, data: { resourceId } });
  } catch (e) {
    console.error('[agency-resource-library] POST resource', e);
    const code = e.statusCode || 400;
    res.status(code).json({ success: false, message: e.message || 'Create failed' });
  }
});

/** PATCH /marketing-resources/reorder */
router.patch('/marketing-resources/reorder', async (req, res) => {
  try {
    const { agencyId } = req.params;
    const pool = await getPool();
    const { tenantId } = await assertAgencyAdmin(pool, req, agencyId);
    const { folderId, orderedResourceIds } = req.body || {};
    const rows = await agencyLib.reorderAgencyResources(
      pool,
      agencyId,
      tenantId,
      req.user.UserId,
      folderId,
      orderedResourceIds
    );
    const resources = await Promise.all(rows.map((row) => agencyLib.mapAgencyResourceRow(row)));
    res.json({ success: true, data: { folderId, resources } });
  } catch (e) {
    console.error('[agency-resource-library] reorder resources', e);
    const code = e.statusCode || 400;
    res.status(code).json({ success: false, message: e.message || 'Reorder failed' });
  }
});

/** PATCH /marketing-resources/:resourceId */
router.patch('/marketing-resources/:resourceId', async (req, res) => {
  try {
    const { agencyId, resourceId } = req.params;
    if (!uuidRe.test(resourceId)) return res.status(400).json({ success: false, message: 'Invalid resource id' });
    const pool = await getPool();
    const { tenantId } = await assertAgencyAdmin(pool, req, agencyId);
    const row = await agencyLib.updateAgencyResource(
      pool,
      agencyId,
      tenantId,
      req.user.UserId,
      resourceId,
      pickAgencyResourcePatch(req.body)
    );
    if (!row) return res.status(404).json({ success: false, message: 'Resource not found' });
    res.json({ success: true, data: row });
  } catch (e) {
    console.error('[agency-resource-library] PATCH resource', e);
    const code = e.statusCode || 400;
    res.status(code).json({ success: false, message: e.message || 'Update failed' });
  }
});

/** DELETE /marketing-resources/:resourceId */
router.delete('/marketing-resources/:resourceId', async (req, res) => {
  try {
    const { agencyId, resourceId } = req.params;
    if (!uuidRe.test(resourceId)) return res.status(400).json({ success: false, message: 'Invalid resource id' });
    const pool = await getPool();
    const { tenantId } = await assertAgencyAdmin(pool, req, agencyId);
    const ok = await agencyLib.deleteAgencyResource(pool, agencyId, tenantId, req.user.UserId, resourceId);
    if (!ok) return res.status(404).json({ success: false, message: 'Resource not found' });
    res.json({ success: true, message: 'Resource removed' });
  } catch (e) {
    console.error('[agency-resource-library] DELETE resource', e);
    const code = e.statusCode || 500;
    res.status(code).json({ success: false, message: e.message || 'Delete failed' });
  }
});

module.exports = router;
