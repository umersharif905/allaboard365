'use strict';

const { getUserRoles } = require('./auth');
const migrationInstance = require('../services/migration/migrationInstance.service');

/**
 * Tenant-admin E123 migration routes: require assigned instance with portal enabled.
 * Sets req.migrationContext = { isTenantPortal, instanceId, tenantId }.
 */
async function requireTenantE123Migration(req, res, next) {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context required' });
    }

    const ctx = await migrationInstance.getTenantPortalContext(tenantId);
    const roles = getUserRoles(req.user);
    const isSysAdmin = roles.includes('SysAdmin');

    if (!ctx?.instanceId) {
      return res.status(403).json({
        success: false,
        message: 'No migration instance is assigned to this tenant'
      });
    }

    if (!ctx.enabled && !isSysAdmin) {
      return res.status(403).json({
        success: false,
        message: 'E123 migration is not enabled for this tenant portal'
      });
    }

    req.migrationContext = {
      isTenantPortal: true,
      instanceId: ctx.instanceId,
      tenantId
    };
    next();
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = requireTenantE123Migration;
