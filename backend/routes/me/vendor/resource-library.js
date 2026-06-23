/**
 * Vendor-scoped resource library. Mounted at /api/me/vendor/resource-library.
 * Mirrors the agency resource library; permissions split between VendorAdmin and VendorAgent.
 */
const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const vendorLib = require('../../../services/shared/vendor-marketing-library.service');

const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

const adminOnly = authorize(['VendorAdmin']);
const adminOrAgent = authorize(['VendorAdmin', 'VendorAgent']);

function tenantIdFromReq(req) {
  return req.tenantId || req.user?.TenantId || null;
}

async function assertVendorContext(req) {
  const tid = tenantIdFromReq(req);
  const vid = req.user?.VendorId;
  if (!tid || !vid) {
    const e = new Error('Vendor context required');
    e.statusCode = 403;
    throw e;
  }
  const pool = await getPool();
  const vendor = await vendorLib.verifyVendor(pool, vid);
  if (!vendor) {
    const e = new Error('Vendor not found');
    e.statusCode = 404;
    throw e;
  }
  return { pool, tenantId: tid, vendorId: vid };
}

function pickFolderBody(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const o = {};
  if (Object.prototype.hasOwnProperty.call(b, 'name')) o.name = b.name;
  if (Object.prototype.hasOwnProperty.call(b, 'description')) o.description = b.description;
  return o;
}

function pickCreateResourceBody(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const o = {};
  for (const k of ['folderId', 'title', 'description', 'resourceType', 'externalUrl', 'fileId', 'fileName', 'storedFileName', 'fileUrl', 'mimeType', 'fileSize']) {
    if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k];
  }
  return o;
}

function pickResourcePatch(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(b, 'title')) patch.title = b.title;
  if (Object.prototype.hasOwnProperty.call(b, 'description')) patch.description = b.description;
  if (Object.prototype.hasOwnProperty.call(b, 'folderId')) patch.folderId = b.folderId;
  return patch;
}

/** GET /folders — full tree (folders + resources) */
router.get('/folders', adminOrAgent, async (req, res) => {
  try {
    const { pool, tenantId, vendorId } = await assertVendorContext(req);
    const tree = await vendorLib.getVendorLibraryTree(pool, vendorId, tenantId);
    res.json({ success: true, data: { folders: tree } });
  } catch (e) {
    console.error('[vendor-resource-library] GET folders', e);
    res.status(e.statusCode || 500).json({ success: false, message: e.message || 'Load failed' });
  }
});

/** POST /folders */
router.post('/folders', adminOrAgent, async (req, res) => {
  try {
    const { pool, tenantId, vendorId } = await assertVendorContext(req);
    const row = await vendorLib.createVendorFolder(pool, vendorId, tenantId, req.user.UserId, pickFolderBody(req.body));
    res.status(201).json({ success: true, data: row });
  } catch (e) {
    console.error('[vendor-resource-library] POST folder', e);
    res.status(e.statusCode || 400).json({ success: false, message: e.message || 'Create failed' });
  }
});

/** PATCH /folders/reorder */
router.patch('/folders/reorder', adminOrAgent, async (req, res) => {
  try {
    const { pool, tenantId, vendorId } = await assertVendorContext(req);
    const { orderedFolderIds } = req.body || {};
    const rows = await vendorLib.reorderVendorFolders(pool, vendorId, tenantId, req.user.UserId, orderedFolderIds);
    res.json({ success: true, data: { folders: rows } });
  } catch (e) {
    console.error('[vendor-resource-library] reorder folders', e);
    res.status(e.statusCode || 400).json({ success: false, message: e.message || 'Reorder failed' });
  }
});

/** PATCH /folders/:folderId */
router.patch('/folders/:folderId', adminOrAgent, async (req, res) => {
  try {
    const { folderId } = req.params;
    if (!uuidRe.test(folderId)) return res.status(400).json({ success: false, message: 'Invalid folder id' });
    const { pool, tenantId, vendorId } = await assertVendorContext(req);
    const row = await vendorLib.updateVendorFolder(pool, vendorId, tenantId, req.user.UserId, folderId, pickFolderBody(req.body));
    if (!row) return res.status(404).json({ success: false, message: 'Folder not found' });
    res.json({ success: true, data: row });
  } catch (e) {
    console.error('[vendor-resource-library] PATCH folder', e);
    res.status(e.statusCode || 400).json({ success: false, message: e.message || 'Update failed' });
  }
});

/** DELETE /folders/:folderId — VendorAdmin only */
router.delete('/folders/:folderId', adminOnly, async (req, res) => {
  try {
    const { folderId } = req.params;
    if (!uuidRe.test(folderId)) return res.status(400).json({ success: false, message: 'Invalid folder id' });
    const { pool, tenantId, vendorId } = await assertVendorContext(req);
    const ok = await vendorLib.deleteVendorFolder(pool, vendorId, tenantId, req.user.UserId, folderId);
    if (!ok) return res.status(404).json({ success: false, message: 'Folder not found' });
    res.json({ success: true, message: 'Folder removed' });
  } catch (e) {
    console.error('[vendor-resource-library] DELETE folder', e);
    res.status(e.statusCode || 500).json({ success: false, message: e.message || 'Delete failed' });
  }
});

/** POST /resources */
router.post('/resources', adminOrAgent, async (req, res) => {
  try {
    const { pool, tenantId, vendorId } = await assertVendorContext(req);
    const resourceId = await vendorLib.createVendorResource(pool, vendorId, tenantId, req.user.UserId, pickCreateResourceBody(req.body));
    res.status(201).json({ success: true, data: { resourceId } });
  } catch (e) {
    console.error('[vendor-resource-library] POST resource', e);
    res.status(e.statusCode || 400).json({ success: false, message: e.message || 'Create failed' });
  }
});

/** PATCH /resources/reorder */
router.patch('/resources/reorder', adminOrAgent, async (req, res) => {
  try {
    const { pool, tenantId, vendorId } = await assertVendorContext(req);
    const { folderId, orderedResourceIds } = req.body || {};
    const rows = await vendorLib.reorderVendorResources(pool, vendorId, tenantId, req.user.UserId, folderId, orderedResourceIds);
    const resources = rows.map((row) => vendorLib.mapVendorResourceRow(row));
    res.json({ success: true, data: { folderId, resources } });
  } catch (e) {
    console.error('[vendor-resource-library] reorder resources', e);
    res.status(e.statusCode || 400).json({ success: false, message: e.message || 'Reorder failed' });
  }
});

/** PATCH /resources/:resourceId */
router.patch('/resources/:resourceId', adminOrAgent, async (req, res) => {
  try {
    const { resourceId } = req.params;
    if (!uuidRe.test(resourceId)) return res.status(400).json({ success: false, message: 'Invalid resource id' });
    const { pool, tenantId, vendorId } = await assertVendorContext(req);
    const row = await vendorLib.updateVendorResource(pool, vendorId, tenantId, req.user.UserId, resourceId, pickResourcePatch(req.body));
    if (!row) return res.status(404).json({ success: false, message: 'Resource not found' });
    res.json({ success: true, data: row });
  } catch (e) {
    console.error('[vendor-resource-library] PATCH resource', e);
    res.status(e.statusCode || 400).json({ success: false, message: e.message || 'Update failed' });
  }
});

/** DELETE /resources/:resourceId — VendorAdmin only */
router.delete('/resources/:resourceId', adminOnly, async (req, res) => {
  try {
    const { resourceId } = req.params;
    if (!uuidRe.test(resourceId)) return res.status(400).json({ success: false, message: 'Invalid resource id' });
    const { pool, tenantId, vendorId } = await assertVendorContext(req);
    const ok = await vendorLib.deleteVendorResource(pool, vendorId, tenantId, req.user.UserId, resourceId);
    if (!ok) return res.status(404).json({ success: false, message: 'Resource not found' });
    res.json({ success: true, message: 'Resource removed' });
  } catch (e) {
    console.error('[vendor-resource-library] DELETE resource', e);
    res.status(e.statusCode || 500).json({ success: false, message: e.message || 'Delete failed' });
  }
});

/** GET /tenants — list active tenants for the source picker (VendorAdmin only) */
router.get('/tenants', adminOnly, async (req, res) => {
  try {
    const { pool } = await assertVendorContext(req);
    const tenants = await vendorLib.listTenantsForCopy(pool);
    res.json({ success: true, data: { tenants } });
  } catch (e) {
    console.error('[vendor-resource-library] GET tenants', e);
    res.status(e.statusCode || 500).json({ success: false, message: e.message || 'Failed to load tenants' });
  }
});

/** GET /organization-catalog?tenantId=... — read-only tree for the chosen source tenant (VendorAdmin only). */
router.get('/organization-catalog', adminOnly, async (req, res) => {
  try {
    const { pool, tenantId } = await assertVendorContext(req);
    const sourceTenantId = (req.query.tenantId && uuidRe.test(String(req.query.tenantId)))
      ? String(req.query.tenantId)
      : tenantId;
    const cat = await vendorLib.getOrganizationCatalogForCopy(pool, sourceTenantId);
    res.json({ success: true, data: cat });
  } catch (e) {
    console.error('[vendor-resource-library] GET organization-catalog', e);
    res.status(e.statusCode || 500).json({ success: false, message: e.message || 'Failed to load catalog' });
  }
});

/** POST /copy-from-organization — VendorAdmin only. Accepts sourceTenantId to choose which tenant to copy from. */
router.post('/copy-from-organization', adminOnly, async (req, res) => {
  try {
    const { pool, tenantId, vendorId } = await assertVendorContext(req);
    const { folderIds, sourceTenantId: rawSourceTenantId } = req.body || {};
    if (!Array.isArray(folderIds) || folderIds.length === 0) {
      return res.status(400).json({ success: false, message: 'folderIds array required' });
    }
    const sourceTenantId = (rawSourceTenantId && uuidRe.test(String(rawSourceTenantId)))
      ? String(rawSourceTenantId)
      : tenantId;
    const tree = await vendorLib.copyFoldersFromOrganization(
      pool,
      vendorId,
      tenantId,
      sourceTenantId,
      req.user.UserId,
      folderIds
    );
    res.json({ success: true, data: { folders: tree } });
  } catch (e) {
    console.error('[vendor-resource-library] POST copy-from-organization', e);
    res.status(e.statusCode || 400).json({ success: false, message: e.message || 'Copy failed' });
  }
});

module.exports = router;
