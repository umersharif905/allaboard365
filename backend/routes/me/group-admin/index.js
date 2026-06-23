const express = require('express');
const router = express.Router();

// Import group-admin specific routes
const groupRoutes = require('./group');
const membersRoutes = require('./members');
const tenantRoutes = require('./tenant');
const usersRoutes = require('./users');
const userManagementRoutes = require('./user-management');
const enrollmentLinkTemplatesRoutes = require('./enrollment-link-templates');

// Mount group-admin sub-routes
router.use('/group', groupRoutes);
console.log('✅ Mounted /api/me/group-admin/group routes');

router.use('/members', membersRoutes);
console.log('✅ Mounted /api/me/group-admin/members routes');

router.use('/tenant', tenantRoutes);
console.log('✅ Mounted /api/me/group-admin/tenant routes');

router.use('/users', usersRoutes);
console.log('✅ Mounted /api/me/group-admin/users routes');

router.use('/user-management', userManagementRoutes);
console.log('✅ Mounted /api/me/group-admin/user-management routes');

router.use('/enrollment-link-templates', enrollmentLinkTemplatesRoutes);
console.log('✅ Mounted /api/me/group-admin/enrollment-link-templates routes');

module.exports = router;