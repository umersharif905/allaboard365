/**
 * Tenant-admin (and SysAdmin via tenant switch) management of an agency's
 * resource library inside their tenant. Mirrors the agent agency-resource-library
 * routes but authorized by tenant ownership of the agency, not agency-admin status.
 *
 * Mounted at /api/me/tenant-admin/agencies/:agencyId
 */
const express = require('express');
const router = express.Router({ mergeParams: true });
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const agencyLib = require('../../../services/shared/agency-marketing-library.service');

const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

router.use(authorize(['TenantAdmin', 'SysAdmin']));

async function assertAgencyInTenant(req, res, next) {
  try {
    const tenantId = req.tenantId;
    const { agencyId } = req.params;
    if (!tenantId) {
      return res.status(401).json({ success: false, message: 'Tenant context is required' });
    }
    if (!uuidRe.test(String(agencyId || ''))) {
      return res.status(400).json({ success: false, message: 'Invalid agencyId' });
    }
    const pool = await getPool();
    const agency = await agencyLib.verifyAgencyInTenant(pool, tenantId, agencyId);
    if (!agency) {
      return res.status(404).json({ success: false, message: 'Agency not found' });
    }
    req._tenantId = tenantId;
    req._agencyId = agencyId;
    req._pool = pool;
    next();
  } catch (e) {
    console.error('[tenant-admin agency-resource-library] auth error', e);
    res.status(500).json({ success: false, message: 'Authorization check failed' });
  }
}

router.use('/library-settings', assertAgencyInTenant);
router.use('/marketing-folders', assertAgencyInTenant);
router.use('/marketing-resources', assertAgencyInTenant);

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

/** GET /marketing-resources — full agency library tree with admin metadata */
router.get('/marketing-resources', async (req, res) => {
  try {
    const folders = await agencyLib.getAgencyLibraryTree(req._pool, req._agencyId, req._tenantId, {
      includeHiddenMeta: true
    });
    const agency = await agencyLib.verifyAgencyInTenant(req._pool, req._tenantId, req._agencyId);
    res.json({
      success: true,
      data: {
        folders,
        agencyId: req._agencyId,
        useCustomResourceLibrary: Boolean(agency?.UseCustomResourceLibrary)
      }
    });
  } catch (e) {
    console.error('[tenant-admin agency-resource-library] GET tree', e);
    res.status(500).json({ success: false, message: e.message || 'Failed to load library' });
  }
});

/** PATCH /library-settings */
router.patch('/library-settings', async (req, res) => {
  try {
    const raw = req.body && typeof req.body === 'object' ? req.body : {};
    if (!Object.prototype.hasOwnProperty.call(raw, 'useCustomResourceLibrary')) {
      return res.status(400).json({ success: false, message: 'useCustomResourceLibrary is required' });
    }
    const row = await agencyLib.updateAgencyLibrarySetting(
      req._pool,
      req._agencyId,
      req._tenantId,
      raw.useCustomResourceLibrary === true
    );
    if (!row) return res.status(404).json({ success: false, message: 'Agency not found' });
    res.json({
      success: true,
      data: {
        agencyId: req._agencyId,
        useCustomResourceLibrary: Boolean(row.UseCustomResourceLibrary)
      }
    });
  } catch (e) {
    console.error('[tenant-admin agency-resource-library] PATCH library-settings', e);
    res.status(500).json({ success: false, message: e.message || 'Update failed' });
  }
});

/** GET /marketing-resources/organization-catalog */
router.get('/marketing-resources/organization-catalog', async (req, res) => {
  try {
    const cat = await agencyLib.getOrganizationCatalogForCopy(req._pool, req._tenantId);
    res.json({ success: true, data: cat });
  } catch (e) {
    console.error('[tenant-admin agency-resource-library] GET organization-catalog', e);
    res.status(500).json({ success: false, message: e.message || 'Failed to load catalog' });
  }
});

/** POST /marketing-resources/copy-from-organization */
router.post('/marketing-resources/copy-from-organization', async (req, res) => {
  try {
    const raw = req.body && typeof req.body === 'object' ? req.body : {};
    const folderIds = raw.folderIds;
    if (!Array.isArray(folderIds) || folderIds.length === 0) {
      return res.status(400).json({ success: false, message: 'folderIds array required' });
    }
    const tree = await agencyLib.copyFoldersFromOrganization(
      req._pool,
      req._agencyId,
      req._tenantId,
      req.user?.UserId || null,
      folderIds
    );
    res.json({ success: true, data: { folders: tree } });
  } catch (e) {
    console.error('[tenant-admin agency-resource-library] POST copy-from-organization', e);
    res.status(400).json({ success: false, message: e.message || 'Copy failed' });
  }
});

/** POST /marketing-folders */
router.post('/marketing-folders', async (req, res) => {
  try {
    const row = await agencyLib.createAgencyFolder(
      req._pool,
      req._agencyId,
      req._tenantId,
      req.user?.UserId || null,
      pickAgencyFolderBody(req.body)
    );
    res.status(201).json({ success: true, data: row });
  } catch (e) {
    console.error('[tenant-admin agency-resource-library] POST folder', e);
    res.status(400).json({ success: false, message: e.message || 'Create failed' });
  }
});

/** PATCH /marketing-folders/reorder */
router.patch('/marketing-folders/reorder', async (req, res) => {
  try {
    const { orderedFolderIds } = req.body || {};
    const rows = await agencyLib.reorderAgencyFolders(
      req._pool,
      req._agencyId,
      req._tenantId,
      req.user?.UserId || null,
      orderedFolderIds
    );
    res.json({ success: true, data: { folders: rows } });
  } catch (e) {
    console.error('[tenant-admin agency-resource-library] reorder folders', e);
    res.status(400).json({ success: false, message: e.message || 'Reorder failed' });
  }
});

/** PATCH /marketing-folders/:folderId */
router.patch('/marketing-folders/:folderId', async (req, res) => {
  try {
    const { folderId } = req.params;
    if (!uuidRe.test(folderId)) return res.status(400).json({ success: false, message: 'Invalid folder id' });
    const row = await agencyLib.updateAgencyFolder(
      req._pool,
      req._agencyId,
      req._tenantId,
      req.user?.UserId || null,
      folderId,
      pickAgencyFolderBody(req.body)
    );
    if (!row) return res.status(404).json({ success: false, message: 'Folder not found' });
    res.json({ success: true, data: row });
  } catch (e) {
    console.error('[tenant-admin agency-resource-library] PATCH folder', e);
    res.status(400).json({ success: false, message: e.message || 'Update failed' });
  }
});

/** DELETE /marketing-folders/:folderId */
router.delete('/marketing-folders/:folderId', async (req, res) => {
  try {
    const { folderId } = req.params;
    if (!uuidRe.test(folderId)) return res.status(400).json({ success: false, message: 'Invalid folder id' });
    const ok = await agencyLib.deleteAgencyFolder(
      req._pool,
      req._agencyId,
      req._tenantId,
      req.user?.UserId || null,
      folderId
    );
    if (!ok) return res.status(404).json({ success: false, message: 'Folder not found' });
    res.json({ success: true, message: 'Folder removed' });
  } catch (e) {
    console.error('[tenant-admin agency-resource-library] DELETE folder', e);
    res.status(500).json({ success: false, message: e.message || 'Delete failed' });
  }
});

/** POST /marketing-resources */
router.post('/marketing-resources', async (req, res) => {
  try {
    const resourceId = await agencyLib.createAgencyResource(
      req._pool,
      req._agencyId,
      req._tenantId,
      req.user?.UserId || null,
      pickCreateAgencyResourceBody(req.body)
    );
    res.status(201).json({ success: true, data: { resourceId } });
  } catch (e) {
    console.error('[tenant-admin agency-resource-library] POST resource', e);
    res.status(400).json({ success: false, message: e.message || 'Create failed' });
  }
});

/** PATCH /marketing-resources/reorder */
router.patch('/marketing-resources/reorder', async (req, res) => {
  try {
    const { folderId, orderedResourceIds } = req.body || {};
    const rows = await agencyLib.reorderAgencyResources(
      req._pool,
      req._agencyId,
      req._tenantId,
      req.user?.UserId || null,
      folderId,
      orderedResourceIds
    );
    const resources = rows.map((row) => agencyLib.mapAgencyResourceRow(row));
    res.json({ success: true, data: { folderId, resources } });
  } catch (e) {
    console.error('[tenant-admin agency-resource-library] reorder resources', e);
    res.status(400).json({ success: false, message: e.message || 'Reorder failed' });
  }
});

/** PATCH /marketing-resources/:resourceId */
router.patch('/marketing-resources/:resourceId', async (req, res) => {
  try {
    const { resourceId } = req.params;
    if (!uuidRe.test(resourceId)) return res.status(400).json({ success: false, message: 'Invalid resource id' });
    const row = await agencyLib.updateAgencyResource(
      req._pool,
      req._agencyId,
      req._tenantId,
      req.user?.UserId || null,
      resourceId,
      pickAgencyResourcePatch(req.body)
    );
    if (!row) return res.status(404).json({ success: false, message: 'Resource not found' });
    res.json({ success: true, data: row });
  } catch (e) {
    console.error('[tenant-admin agency-resource-library] PATCH resource', e);
    res.status(400).json({ success: false, message: e.message || 'Update failed' });
  }
});

/** DELETE /marketing-resources/:resourceId */
router.delete('/marketing-resources/:resourceId', async (req, res) => {
  try {
    const { resourceId } = req.params;
    if (!uuidRe.test(resourceId)) return res.status(400).json({ success: false, message: 'Invalid resource id' });
    const ok = await agencyLib.deleteAgencyResource(
      req._pool,
      req._agencyId,
      req._tenantId,
      req.user?.UserId || null,
      resourceId
    );
    if (!ok) return res.status(404).json({ success: false, message: 'Resource not found' });
    res.json({ success: true, message: 'Resource removed' });
  } catch (e) {
    console.error('[tenant-admin agency-resource-library] DELETE resource', e);
    res.status(500).json({ success: false, message: e.message || 'Delete failed' });
  }
});

module.exports = router;
