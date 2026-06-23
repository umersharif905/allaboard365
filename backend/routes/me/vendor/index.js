const express = require('express');
const router = express.Router();

// Import vendor-specific routes
const vendorProfileRoutes = require('./profile');
const vendorProductsRoutes = require('./products');
const vendorPaymentsRoutes = require('./payments');
const vendorResourceLibraryRoutes = require('./resource-library');
const vendorAsaAgreementsRoutes = require('./asa-agreements');
const vendorUsersRoutes = require('./users');
const vendorTrainingRoutes = require('./training');
const vendorCallCenterRoutes = require('./call-center');

// Import Share Request Management routes (enabled per vendor)
const shareRequestRoutes = require('./share-requests');
const requestTypeRoutes = require('./request-types');
const casesRoutes = require('./cases');
const caseForwardingRoutes = require('./case-forwarding');
const encountersRoutes = require('./encounters');
const caseStudyRoutes = require('./case-studies');
const inboxRoutes = require('./inbox');
const providerRoutes = require('./providers');
const memberRoutes = require('./members');
const memberDirectDepositsRoutes = require('./member-direct-deposits');
const vendorImportRoutes = require('./import');
const sftpConnectionsRoutes = require('./sftp-connections');
const importJobsRoutes = require('./import-jobs');
const importJobRunsRoutes = require('./import-job-runs');
const npiRoutes = require('./npi');
const fapRoutes = require('./fap');
const vendorPublicFormsRoutes = require('./public-forms');
const dashboardRoutes = require('./dashboard');
const pricingRoutes = require('./pricing');
const notificationsRoutes = require('./notifications');
const vendorInvoicesRoutes = require('./invoices');

// Import ARM Export route (for SysAdmin/TenantAdmin)
let armExportRoutes;
try {
    armExportRoutes = require('./arm-export');
    console.log('✅ ARM Export routes imported successfully');
} catch (e) {
    console.warn('⚠️ ARM Export routes not found:', e.message);
}

// Mount vendor routes
router.use('/profile', vendorProfileRoutes);
router.use('/products', vendorProductsRoutes);
router.use('/payments', vendorPaymentsRoutes);
router.use('/resource-library', vendorResourceLibraryRoutes);
router.use('/asa-agreements', vendorAsaAgreementsRoutes);
router.use('/users', vendorUsersRoutes);
router.use('/training', vendorTrainingRoutes);
router.use('/call-center', vendorCallCenterRoutes);

// Mount Share Request Management routes
router.use('/share-requests', shareRequestRoutes);
router.use('/request-types', requestTypeRoutes);
router.use('/cases', casesRoutes);
router.use('/case-forwarding', caseForwardingRoutes);
router.use('/encounters', encountersRoutes);
router.use('/case-studies', caseStudyRoutes);
router.use('/inbox', inboxRoutes);
router.use('/providers', providerRoutes);
// Member-scoped sub-resources mounted before /members so :memberId resolves.
router.use('/members/:memberId/direct-deposits', memberDirectDepositsRoutes);
router.use('/members', memberRoutes);
router.use('/import', vendorImportRoutes);
router.use('/sftp-connections', sftpConnectionsRoutes);
router.use('/import-jobs', importJobsRoutes);
router.use('/import-job-runs', importJobRunsRoutes);
router.use('/npi', npiRoutes);
router.use('/public-forms', vendorPublicFormsRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/pricing', pricingRoutes);
router.use('/notifications', notificationsRoutes);
router.use('/invoices', vendorInvoicesRoutes);
router.use('/', fapRoutes); // FAP routes use paths like /providers/:id/fap/... and /fap/...

// Mount ARM Export route (accessible to SysAdmin/TenantAdmin)
if (armExportRoutes) {
    router.use('/arm-export', armExportRoutes);
    console.log('✅ Mounted /api/me/vendor/arm-export');
}

console.log('✅ Mounted /api/me/vendor routes (profile, products, payments, resource-library, asa-agreements, users, training, share-requests, request-types, cases, encounters, providers, members, npi, public-forms, dashboard, notifications, fap, arm-export)');

module.exports = router;

