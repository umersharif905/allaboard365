const express = require('express');
const router = express.Router();

// Import sysadmin-specific routes
const sysadminEnrollmentLinkTemplatesRoutes = require('./enrollment-link-templates');
const sysadminGroupsRoutes = require('./groups');
const sysadminPaymentProcessorStatusRoutes = require('./payment-processor-status');
const sysadminBillingRoutes = require('./billing');
const sysadminUsersRoutes = require('./users');
const sysadminIntegrationErrorsRoutes = require('./integration-errors');
const sysadminAiInspectorReportsRoutes = require('./ai-inspector-reports');
const sysadminMarketingResourcesRoutes = require('./marketing-resources');
const sysadminVendorsRoutes = require('./vendors');

// Mount sysadmin routes
router.use('/enrollment-link-templates', sysadminEnrollmentLinkTemplatesRoutes);
router.use('/groups', sysadminGroupsRoutes);
router.use('/payment-processor-status', sysadminPaymentProcessorStatusRoutes);
router.use('/billing', sysadminBillingRoutes);
router.use('/users', sysadminUsersRoutes);
router.use('/integration-errors', sysadminIntegrationErrorsRoutes);
router.use('/ai-inspector-reports', sysadminAiInspectorReportsRoutes);
router.use('/marketing-resources', sysadminMarketingResourcesRoutes);
router.use('/vendors', sysadminVendorsRoutes);

console.log('✅ Mounted /api/me/sysadmin routes (enrollment-link-templates, groups, billing, users, integration-errors, ai-inspector-reports, marketing-resources, vendors)');

module.exports = router;