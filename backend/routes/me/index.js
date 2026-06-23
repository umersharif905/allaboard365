const express = require('express');
const router = express.Router();

// Import role-specific routes
const memberRoutes = require('./member');
const agentRoutes = require('./agent');
const tenantAdminRoutes = require('./tenant-admin');
const groupAdminRoutes = require('./group-admin');
const sysadminRoutes = require('./sysadmin');
const vendorRoutes = require('./vendor');
const enrollmentLinksRoutes = require('./enrollment-links');
const bugReportRoutes = require('./bug-report');
const notificationPreferencesRoutes = require('./notification-preferences');

// Import pricing routes
const memberPricingRoutes = require('./member/pricing');
const agentPricingRoutes = require('./agent/pricing');
const tenantAdminPricingRoutes = require('./tenant-admin/pricing');

// Mount member routes without additional authorization middleware
// This is because we've already applied authentication and will handle authorization in the specific routes
router.use('/member', memberRoutes);
console.log('✅ Mounted /api/me/member routes (authorization handled in specific routes)');

// Mount agent routes
router.use('/agent', agentRoutes);
console.log('✅ Mounted /api/me/agent routes (authorization handled in specific routes)');

// Mount tenant-admin routes
router.use('/tenant-admin', tenantAdminRoutes);
console.log('✅ Mounted /api/me/tenant-admin routes (authorization handled in specific routes)');

// Mount group-admin routes
router.use('/group-admin', groupAdminRoutes);
console.log('✅ Mounted /api/me/group-admin routes (authorization handled in specific routes)');

// Mount sysadmin routes
router.use('/sysadmin', sysadminRoutes);
console.log('✅ Mounted /api/me/sysadmin routes (authorization handled in specific routes)');

// Mount vendor routes
router.use('/vendor', vendorRoutes);
console.log('✅ Mounted /api/me/vendor routes (authorization handled in specific routes)');

// Mount enrollment-links routes (authenticated)
router.use('/enrollment-links', enrollmentLinksRoutes);
console.log('✅ Mounted /api/me/enrollment-links routes (authorization handled in specific routes)');

router.use('/bug-report', bugReportRoutes);
console.log('✅ Mounted /api/me/bug-report routes');

// Per-agent notification preferences (e.g. new-prospect email opt-out)
router.use('/notification-preferences', notificationPreferencesRoutes);
console.log('✅ Mounted /api/me/notification-preferences routes');

// Mount pricing routes for each role
router.use('/member/pricing', memberPricingRoutes);
console.log('✅ Mounted /api/me/member/pricing routes');

router.use('/agent/pricing', agentPricingRoutes);
console.log('✅ Mounted /api/me/agent/pricing routes');

router.use('/tenant-admin/pricing', tenantAdminPricingRoutes);
console.log('✅ Mounted /api/me/tenant-admin/pricing routes');

module.exports = router; 