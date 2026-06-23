/**
 * Tenant resource library (marketing documents); Pattern 1 in prompts/backend-system.md:
 * /api/me/tenant-admin/*, authorize(['TenantAdmin']). Tenant scope: requireTenantAccess on
 * ../tenant-admin/index.js (sets req.tenantId from x-current-tenant-id / switch).
 */
const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const tenantMarketingLibrary = require('../../../services/shared/tenant-marketing-library.service');

const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

router.use(authorize(['TenantAdmin', 'SysAdmin']));

/** Whitelist POST body (create) — only fields read by createResource. */
function pickCreateMarketingResourceBody(body) {
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

/** Whitelist PATCH body fields (input validation; avoid passing arbitrary req.body to services). */
function pickMarketingResourcePatch(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(b, 'title')) patch.title = b.title;
  if (Object.prototype.hasOwnProperty.call(b, 'description')) patch.description = b.description;
  if (Object.prototype.hasOwnProperty.call(b, 'folderId')) patch.folderId = b.folderId;
  return patch;
}

/**
 * GET /api/me/tenant-admin/marketing-resources
 * No folderId: full tree (folders + resources). ?folderId=uuid: resources in folder only.
 */
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = req.tenantId;
    const folderId = req.query.folderId;

    if (folderId) {
      if (!uuidRe.test(String(folderId))) {
        return res.status(400).json({ success: false, message: 'Invalid folderId' });
      }
      const folder = await tenantMarketingLibrary.verifyFolderOwned(pool, tenantId, folderId);
      if (!folder) return res.status(404).json({ success: false, message: 'Folder not found' });
      const rows = await tenantMarketingLibrary.listResourcesInFolder(pool, tenantId, folderId);
      const resources = await Promise.all(rows.map((row) => tenantMarketingLibrary.mapResourceRow(row)));
      return res.json({ success: true, data: { folderId, resources } });
    }

    await tenantMarketingLibrary.ensureDefaultFolder(pool, tenantId, req.user.UserId);
    const tree = await tenantMarketingLibrary.getLibraryTree(pool, tenantId);
    res.json({ success: true, data: { folders: tree } });
  } catch (e) {
    console.error('[marketing-resources] GET', e);
    res.status(500).json({ success: false, message: e.message || 'Failed to load resources' });
  }
});

/**
 * POST /api/me/tenant-admin/marketing-resources
 */
router.post('/', async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = req.tenantId;
    const resourceId = await tenantMarketingLibrary.createResource(
      pool,
      tenantId,
      req.user.UserId,
      pickCreateMarketingResourceBody(req.body)
    );
    res.status(201).json({ success: true, data: { resourceId } });
  } catch (e) {
    console.error('[marketing-resources] POST', e);
    res.status(400).json({ success: false, message: e.message || 'Create failed' });
  }
});

/**
 * PATCH /api/me/tenant-admin/marketing-resources/reorder
 */
router.patch('/reorder', async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = req.tenantId;
    const { folderId, orderedResourceIds } = req.body;
    if (!folderId || !uuidRe.test(folderId)) {
      return res.status(400).json({ success: false, message: 'folderId required' });
    }
    const rows = await tenantMarketingLibrary.reorderResources(
      pool,
      tenantId,
      req.user.UserId,
      folderId,
      orderedResourceIds
    );
    const resources = await Promise.all(rows.map((row) => tenantMarketingLibrary.mapResourceRow(row)));
    res.json({ success: true, data: { folderId, resources } });
  } catch (e) {
    console.error('[marketing-resources] reorder', e);
    res.status(400).json({ success: false, message: e.message || 'Reorder failed' });
  }
});

/**
 * PATCH /api/me/tenant-admin/marketing-resources/:resourceId
 */
router.patch('/:resourceId', async (req, res) => {
  try {
    const { resourceId } = req.params;
    if (!uuidRe.test(resourceId)) {
      return res.status(400).json({ success: false, message: 'Invalid resource id' });
    }
    const pool = await getPool();
    const tenantId = req.tenantId;
    const row = await tenantMarketingLibrary.updateResource(
      pool,
      tenantId,
      req.user.UserId,
      resourceId,
      pickMarketingResourcePatch(req.body)
    );
    if (!row) return res.status(404).json({ success: false, message: 'Resource not found' });
    res.json({ success: true, data: row });
  } catch (e) {
    console.error('[marketing-resources] PATCH', e);
    res.status(400).json({ success: false, message: e.message || 'Update failed' });
  }
});

/**
 * DELETE /api/me/tenant-admin/marketing-resources/:resourceId
 */
router.delete('/:resourceId', async (req, res) => {
  try {
    const { resourceId } = req.params;
    if (!uuidRe.test(resourceId)) {
      return res.status(400).json({ success: false, message: 'Invalid resource id' });
    }
    const pool = await getPool();
    const tenantId = req.tenantId;
    const ok = await tenantMarketingLibrary.deleteResource(pool, tenantId, req.user.UserId, resourceId);
    if (!ok) return res.status(404).json({ success: false, message: 'Resource not found' });
    res.json({ success: true, message: 'Resource removed' });
  } catch (e) {
    console.error('[marketing-resources] DELETE', e);
    res.status(500).json({ success: false, message: e.message || 'Delete failed' });
  }
});

module.exports = router;
