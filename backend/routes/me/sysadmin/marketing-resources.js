/**
 * Sysadmin marketing resource library cross-tenant tools.
 *
 * Endpoints:
 *   GET  /api/me/sysadmin/marketing-resources/tenants/:tenantId/library
 *        Read a tenant's marketing library (admin view) for selection in the copy UI.
 *   POST /api/me/sysadmin/marketing-resources/copy-between-tenants
 *        Copy selected folders (and their nested resources) from a source tenant to a
 *        target tenant. Creates fully independent rows on the target — new folder /
 *        resource ids, and for file resources new oe.FileUploads rows + new blobs.
 *
 * Note: this is COPY-only. We deliberately do not maintain a sharing table such as
 * TenantMarketingFolderTenantAccess; cross-tenant resources are copied snapshots, not
 * live shared content.
 */
const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const tenantMk = require('../../../services/shared/tenant-marketing-library.service');

router.use(authorize(['SysAdmin']));

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

router.get('/tenants/:tenantId/library', async (req, res) => {
  try {
    const { tenantId } = req.params;
    if (!UUID_RE.test(String(tenantId || ''))) {
      return res.status(400).json({ success: false, message: 'Invalid tenantId' });
    }
    const pool = await getPool();
    const folders = await tenantMk.getLibraryTree(pool, tenantId, { forAgentView: false });
    res.json({ success: true, data: { folders } });
  } catch (err) {
    console.error('❌ sysadmin tenant library load failed:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to load library' });
  }
});

router.post('/copy-between-tenants', async (req, res) => {
  try {
    const { sourceTenantId, targetTenantId, folderIds } = req.body || {};
    if (!UUID_RE.test(String(sourceTenantId || ''))) {
      return res.status(400).json({ success: false, message: 'Invalid sourceTenantId' });
    }
    if (!UUID_RE.test(String(targetTenantId || ''))) {
      return res.status(400).json({ success: false, message: 'Invalid targetTenantId' });
    }
    if (!Array.isArray(folderIds) || folderIds.length === 0) {
      return res.status(400).json({ success: false, message: 'folderIds must be a non-empty array' });
    }
    for (const id of folderIds) {
      if (!UUID_RE.test(String(id || ''))) {
        return res.status(400).json({ success: false, message: 'Invalid folderId in list' });
      }
    }

    const pool = await getPool();
    const folders = await tenantMk.copyFoldersBetweenTenants(pool, {
      sourceTenantId,
      targetTenantId,
      folderIds,
      userId: req.user?.userId || null
    });
    res.json({
      success: true,
      data: {
        sourceTenantId,
        targetTenantId,
        copiedFolderCount: folderIds.length,
        targetLibrary: { folders }
      }
    });
  } catch (err) {
    console.error('❌ sysadmin copy-between-tenants failed:', err);
    res.status(400).json({ success: false, message: err.message || 'Copy failed' });
  }
});

module.exports = router;
