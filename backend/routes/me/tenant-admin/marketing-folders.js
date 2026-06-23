/**
 * Resource library folder CRUD; Pattern 1 in prompts/backend-system.md. Tenant scope via
 * requireTenantAccess on ../tenant-admin/index.js.
 */
const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const tenantMarketingLibrary = require('../../../services/shared/tenant-marketing-library.service');

const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

router.use(authorize(['TenantAdmin', 'SysAdmin']));

/** Whitelist folder write body (create + PATCH) — only fields read by createFolder / updateFolder. */
function pickMarketingFolderBody(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const o = {};
  if (Object.prototype.hasOwnProperty.call(b, 'name')) o.name = b.name;
  if (Object.prototype.hasOwnProperty.call(b, 'description')) o.description = b.description;
  if (Object.prototype.hasOwnProperty.call(b, 'hideFromAgents')) o.hideFromAgents = b.hideFromAgents;
  return o;
}

function mapFolder(f) {
  if (!f) return null;
  return {
    folderId: f.FolderId,
    name: f.Name,
    description: f.Description,
    sortOrder: f.SortOrder,
    isActive: f.IsActive,
    hideFromAgents: Boolean(f.HideFromAgents),
    createdDate: f.CreatedDate,
    modifiedDate: f.ModifiedDate
  };
}

/**
 * GET /api/me/tenant-admin/marketing-folders
 */
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = req.tenantId;
    await tenantMarketingLibrary.ensureDefaultFolder(pool, tenantId, req.user.UserId);
    const rows = await tenantMarketingLibrary.listFolders(pool, tenantId);
    res.json({ success: true, data: rows.map(mapFolder) });
  } catch (e) {
    console.error('[marketing-folders] GET', e);
    res.status(500).json({ success: false, message: e.message || 'Failed to list folders' });
  }
});

/**
 * POST /api/me/tenant-admin/marketing-folders
 */
router.post('/', async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = req.tenantId;
    const row = await tenantMarketingLibrary.createFolder(
      pool,
      tenantId,
      req.user.UserId,
      pickMarketingFolderBody(req.body)
    );
    res.status(201).json({ success: true, data: mapFolder(row) });
  } catch (e) {
    console.error('[marketing-folders] POST', e);
    const msg = e.message || 'Create failed';
    const hint =
      /Invalid object name ['"]?oe\.TenantMarketingFolders/i.test(msg) ||
      /Invalid object name ['"]?TenantMarketingFolders/i.test(msg)
        ? ' Run sql-changes/2026-04-03-tenant-marketing-folders-and-resources.sql on the database if you have not already.'
        : '';
    res.status(400).json({ success: false, message: msg + hint });
  }
});

/**
 * PATCH /api/me/tenant-admin/marketing-folders/reorder
 */
router.patch('/reorder', async (req, res) => {
  try {
    const pool = await getPool();
    const tenantId = req.tenantId;
    const rows = await tenantMarketingLibrary.reorderFolders(
      pool,
      tenantId,
      req.user.UserId,
      req.body.orderedFolderIds
    );
    res.json({ success: true, data: rows.map(mapFolder) });
  } catch (e) {
    console.error('[marketing-folders] reorder', e);
    res.status(400).json({ success: false, message: e.message || 'Reorder failed' });
  }
});

/**
 * PATCH /api/me/tenant-admin/marketing-folders/:folderId
 */
router.patch('/:folderId', async (req, res) => {
  try {
    const { folderId } = req.params;
    if (!uuidRe.test(folderId)) {
      return res.status(400).json({ success: false, message: 'Invalid folder id' });
    }
    const pool = await getPool();
    const tenantId = req.tenantId;
    const row = await tenantMarketingLibrary.updateFolder(
      pool,
      tenantId,
      req.user.UserId,
      folderId,
      pickMarketingFolderBody(req.body)
    );
    if (!row) return res.status(404).json({ success: false, message: 'Folder not found' });
    res.json({ success: true, data: mapFolder(row) });
  } catch (e) {
    console.error('[marketing-folders] PATCH', e);
    res.status(400).json({ success: false, message: e.message || 'Update failed' });
  }
});

/**
 * DELETE /api/me/tenant-admin/marketing-folders/:folderId
 */
router.delete('/:folderId', async (req, res) => {
  try {
    const { folderId } = req.params;
    if (!uuidRe.test(folderId)) {
      return res.status(400).json({ success: false, message: 'Invalid folder id' });
    }
    const pool = await getPool();
    const tenantId = req.tenantId;
    const ok = await tenantMarketingLibrary.deleteFolder(pool, tenantId, req.user.UserId, folderId);
    if (!ok) return res.status(404).json({ success: false, message: 'Folder not found' });
    res.json({ success: true, message: 'Folder removed' });
  } catch (e) {
    console.error('[marketing-folders] DELETE', e);
    res.status(500).json({ success: false, message: e.message || 'Delete failed' });
  }
});

module.exports = router;
