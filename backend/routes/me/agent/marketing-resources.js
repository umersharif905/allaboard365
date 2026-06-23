const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const { getPool } = require('../../../config/database');
const tenantMarketingLibrary = require('../../../services/shared/tenant-marketing-library.service');
const agencyMarketingLibrary = require('../../../services/shared/agency-marketing-library.service');
const agencyAdmins = require('../../../utils/agencyAdmins');

router.use(authorize(['Agent']));

function tenantIdFromReq(req) {
  return req.tenantId || req.user?.TenantId || null;
}

/**
 * GET /api/me/agent/marketing-resources
 * Read-only library; when agency has UseCustomResourceLibrary, returns agency tree only (see agency-resource-library routes for admin CRUD).
 */
router.get('/', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const pool = await getPool();
    let tenantId = tenantIdFromReq(req);
    if (!tenantId) {
      tenantId = await tenantMarketingLibrary.resolveAgentTenantId(pool, req.user);
    }
    if (!tenantId) {
      return res.status(404).json({ success: false, message: 'Tenant not found for agent' });
    }

    const profile = await agencyMarketingLibrary.getAgentProfileForUser(pool, req.user.UserId);
    const organizationName = await agencyMarketingLibrary.getOrganizationDisplayName(pool, tenantId);

    let agencyId = null;
    let useCustomResourceLibrary = false;
    let isAgencyAdminUser = false;

    if (profile?.AgencyId && profile?.AgentId) {
      agencyId = profile.AgencyId;
      isAgencyAdminUser = await agencyAdmins.isAgencyAdmin(pool, profile.AgencyId, profile.AgentId);
      const agencyRow = await agencyMarketingLibrary.verifyAgencyInTenant(pool, tenantId, profile.AgencyId);
      if (agencyRow) {
        useCustomResourceLibrary = Boolean(agencyRow.UseCustomResourceLibrary);
      }
    }

    if (agencyId && useCustomResourceLibrary) {
      const folders = await agencyMarketingLibrary.getAgencyLibraryTree(pool, agencyId, tenantId);
      return res.json({
        success: true,
        data: {
          libraryMode: 'agency',
          organizationName,
          agencyId,
          useCustomResourceLibrary: true,
          isAgencyAdmin: isAgencyAdminUser,
          folders
        }
      });
    }

    await tenantMarketingLibrary.ensureDefaultFolder(pool, tenantId, null);
    const tree = await tenantMarketingLibrary.getLibraryTree(pool, tenantId, { forAgentView: true });
    res.json({
      success: true,
      data: {
        libraryMode: 'organization',
        organizationName,
        agencyId,
        useCustomResourceLibrary: false,
        isAgencyAdmin: isAgencyAdminUser,
        folders: tree
      }
    });
  } catch (e) {
    console.error('[agent marketing-resources] GET', e);
    res.status(500).json({ success: false, message: e.message || 'Failed to load marketing resources' });
  }
});

module.exports = router;
