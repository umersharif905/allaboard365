const express = require('express');
const router = express.Router();
const requireTenantAccess = require('../../../middleware/requireTenantAccess');

// Apply requireTenantAccess to all tenant-admin routes to support tenant switching
router.use(requireTenantAccess);

// Import tenant-admin-specific routes
const tenantAdminGroupsRoutes = require('./groups');
const tenantAdminMembersRoutes = require('./members');
const tenantAdminTenantRoutes = require('./tenant');
const tenantAdminEnrollmentLinkTemplatesRoutes = require('./enrollment-link-templates');
const tenantAdminProductsRoutes = require('./products');
const tenantAdminMyProductsRoutes = require('./my-products');
const tenantAdminUsersRoutes = require('./users');
const tenantAdminUserManagementRoutes = require('./user-management');
const tenantAdminOnboardingLinksRoutes = require('./onboarding-links');
const tenantAdminAgentOnboardingRoutes = require('./agent-onboarding');
const tenantAdminSettingsRoutes = require('./settings');
const tenantAdminProductOverridesRoutes = require('./product-overrides');
const tenantAdminAvailableTenantsRoutes = require('./available-tenants');
const tenantAdminAccessibleTenantsRoutes = require('./accessible-tenants');
const tenantAdminOverrideACHAccountsRoutes = require('./override-ach-accounts');
const tenantAdminTenantPayoutACHAccountsRoutes = require('./tenant-payout-ach-accounts');
const tenantAdminPaymentProcessorStatusRoutes = require('./payment-processor-status');
const tenantAdminAgenciesRoutes = require('./agencies');
const tenantAdminBillingRoutes = require('./billing');
const tenantAdminProductAPIRoutes = require('./product-api');
const tenantAdminPlanModificationsRoutes = require('./plan-modifications');
const tenantAdminProductMigrationsRoutes = require('./product-migrations');
const tenantAdminEnrollmentAuditRoutes = require('./enrollment-audit');
const tenantAdminUserSessionsRoutes = require('./user-sessions');
const tenantAdminMessageBlastRoutes = require('./message-blast');
const tenantAdminTrainingLibraryRoutes = require('./training-library');
const tenantAdminPublicFormsRoutes = require('./public-forms');
const tenantAdminMarketingFoldersRoutes = require('./marketing-folders');
const tenantAdminMarketingResourcesRoutes = require('./marketing-resources');
const tenantAdminAgencyResourceLibraryRoutes = require('./agency-resource-library');
const tenantAdminMemberDirectDepositsRoutes = require('./member-direct-deposits');
const tenantAdminE123MigrationRoutes = require('./e123-migration');

// Mount tenant-admin routes
router.use('/agencies/:agencyId', tenantAdminAgencyResourceLibraryRoutes);
router.use('/agencies', tenantAdminAgenciesRoutes);
router.use('/billing', tenantAdminBillingRoutes);
router.use('/groups', tenantAdminGroupsRoutes);
// Member-scoped sub-resources must be mounted before the bare /members
// router so the :memberId path-segment doesn't get swallowed.
router.use('/members/:memberId/direct-deposits', tenantAdminMemberDirectDepositsRoutes);
router.use('/members', tenantAdminMembersRoutes);
router.use('/users', tenantAdminUsersRoutes);
router.use('/user-management', tenantAdminUserManagementRoutes);
router.use('/tenant', tenantAdminTenantRoutes);
router.use('/enrollment-link-templates', tenantAdminEnrollmentLinkTemplatesRoutes);
router.use('/products', tenantAdminProductsRoutes);
router.use('/my-products', tenantAdminMyProductsRoutes);
router.use('/products', tenantAdminProductOverridesRoutes);
router.use('/available-tenants', tenantAdminAvailableTenantsRoutes);
router.use('/accessible-tenants', tenantAdminAccessibleTenantsRoutes);
router.use('/override-ach-accounts', tenantAdminOverrideACHAccountsRoutes);
router.use('/tenant-payout-ach-accounts', tenantAdminTenantPayoutACHAccountsRoutes);
router.use('/onboarding-links', tenantAdminOnboardingLinksRoutes);
router.use('/agent-onboarding', tenantAdminAgentOnboardingRoutes);
router.use('/settings', tenantAdminSettingsRoutes);
router.use('/payment-processor-status', tenantAdminPaymentProcessorStatusRoutes);
router.use('/product-api', tenantAdminProductAPIRoutes);
router.use('/plan-modifications', tenantAdminPlanModificationsRoutes);
router.use('/product-migrations', tenantAdminProductMigrationsRoutes);
router.use('/e123-migration', tenantAdminE123MigrationRoutes);
router.use('/enrollment-audit', tenantAdminEnrollmentAuditRoutes);
router.use('/user-sessions', tenantAdminUserSessionsRoutes);
router.use('/message-blast', tenantAdminMessageBlastRoutes);
router.use('/training-library', tenantAdminTrainingLibraryRoutes);
router.use('/public-forms', tenantAdminPublicFormsRoutes);
router.use('/marketing-folders', tenantAdminMarketingFoldersRoutes);
router.use('/marketing-resources', tenantAdminMarketingResourcesRoutes);

console.log('✅ Mounted /api/me/tenant-admin routes (agencies, groups, members, tenant, enrollment-link-templates, products, my-products, onboarding-links, agent-onboarding, settings, public-forms, marketing-folders, marketing-resources)');

module.exports = router; 