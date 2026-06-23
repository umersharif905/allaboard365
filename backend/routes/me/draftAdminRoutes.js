// Shared "in-progress drafts" admin endpoints for the forms surfaces
// (tenant-admin + vendor). Registers GET /drafts and DELETE /drafts/:draftId.
//
// The host router is expected to already apply authenticate + requireTenantAccess
// + role authorization (both surfaces do via router.use). These handlers read the
// resolved `req.tenantId` and are tenant-scoped. Deleting purges staged blobs.
const publicFormDraftService = require('../../services/publicFormDraftService');
const { deleteAzureBlob } = require('../uploads');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Delete staged draft blobs (best-effort). BlobPath is `${container}/${blobName}`. */
async function purgeDraftBlobs(blobPaths) {
  for (const p of blobPaths || []) {
    if (!p) continue;
    const slash = String(p).indexOf('/');
    if (slash < 0) continue;
    try {
      await deleteAzureBlob(p.slice(0, slash), p.slice(slash + 1));
    } catch (e) {
      console.warn('purgeDraftBlobs (admin): failed to delete', p, e.message);
    }
  }
}

/**
 * @param {import('express').Router} router host router (already auth-gated)
 * @param {{ deleteMiddleware?: import('express').RequestHandler }} [opts]
 *        Optional extra guard on DELETE (e.g. vendor write-role restriction).
 */
function registerDraftAdminRoutes(router, opts = {}) {
  const deleteGuards = opts.deleteMiddleware ? [opts.deleteMiddleware] : [];

  router.get('/drafts', async (req, res) => {
    try {
      const tenantId = req.tenantId;
      if (!tenantId) return res.status(400).json({ success: false, message: 'tenantId required' });
      const drafts = await publicFormDraftService.listDraftsForTenant(tenantId);
      return res.json({ success: true, data: { drafts } });
    } catch (e) {
      console.error('admin GET drafts error:', e);
      return res.status(500).json({ success: false, message: 'Failed to load drafts' });
    }
  });

  router.get('/drafts/:draftId', async (req, res) => {
    try {
      const tenantId = req.tenantId;
      if (!tenantId) return res.status(400).json({ success: false, message: 'tenantId required' });
      const { draftId } = req.params;
      if (!UUID_RE.test(String(draftId || ''))) {
        return res.status(400).json({ success: false, message: 'Invalid draftId.' });
      }
      const draft = await publicFormDraftService.getDraftForTenant(draftId, tenantId);
      if (!draft) return res.status(404).json({ success: false, message: 'Draft not found.' });
      return res.json({ success: true, data: { draft } });
    } catch (e) {
      console.error('admin GET one draft error:', e);
      return res.status(500).json({ success: false, message: 'Failed to load draft' });
    }
  });

  router.delete('/drafts/:draftId', ...deleteGuards, async (req, res) => {
    try {
      const tenantId = req.tenantId;
      if (!tenantId) return res.status(400).json({ success: false, message: 'tenantId required' });
      const { draftId } = req.params;
      if (!UUID_RE.test(String(draftId || ''))) {
        return res.status(400).json({ success: false, message: 'Invalid draftId.' });
      }
      const { deleted, blobPaths } = await publicFormDraftService.deleteDraftForTenant(draftId, tenantId);
      if (!deleted) return res.status(404).json({ success: false, message: 'Draft not found.' });
      await purgeDraftBlobs(blobPaths);
      return res.json({ success: true });
    } catch (e) {
      console.error('admin DELETE draft error:', e);
      return res.status(500).json({ success: false, message: 'Failed to delete draft' });
    }
  });
}

module.exports = { registerDraftAdminRoutes };
