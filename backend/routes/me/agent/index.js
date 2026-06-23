const express = require('express');
const router = express.Router();

// Import agent-specific routes
const agentGroupsRoutes = require('./groups');
const agentMembersRoutes = require('./members');
const agentProductsRoutes = require('./products');
const agentTenantRoutes = require('./tenant');
const agentProfileRoutes = require('./profile');
const agentOutboundEmailSenderRoutes = require('./outbound-email-sender');
const agentBankInfoRoutes = require('./bank-info');
const agentDocumentsRoutes = require('./documents');
const agentLicensesRoutes = require('./licenses');
const agentEnrollmentLinkTemplatesRoutes = require('./enrollment-link-templates');
const agentEnrollmentLinksRoutes = require('./enrollment-links');
const agentGroupOnboardingRoutes = require('./group-onboarding');
const agentOnboardingLinksRoutes = require('./onboarding-links');
const agentAgentsRoutes = require('./agents');
const agentCommissionRulesRoutes = require('./commission-rules');
const agentPayoutsRoutes = require('./payouts');
const agentPaymentsRoutes = require('./payments');
const agentPaymentProcessorStatusRoutes = require('./payment-processor-status');
const agentTrainingRoutes = require('./training');
const agentMarketingResourcesRoutes = require('./marketing-resources');
const agentAgencyResourceLibraryRoutes = require('./agency-resource-library');
const agentAgenciesRoutes = require('./agencies');
const agentBillingRoutes = require('./billing');
const agentAssignableAgentsRoutes = require('./assignable-agents');
const agentGroupTypeChangeRequestsRoutes = require('./group-type-change-requests');
const agentMarketingLinkRoutes = require('./marketing-link');
const agentNotificationPreferencesRoutes = require('./notification-preferences');
const agentUsersRoutes = require('./users');

// Mount agent routes
router.use('/groups', agentGroupsRoutes);
router.use('/members', agentMembersRoutes);
router.use('/users', agentUsersRoutes);
router.use('/products', agentProductsRoutes);
router.use('/tenant', agentTenantRoutes);
router.use('/profile', agentProfileRoutes);
router.use('/outbound-email-sender', agentOutboundEmailSenderRoutes);
router.use('/bank-info', agentBankInfoRoutes);
router.use('/documents', agentDocumentsRoutes);
router.use('/licenses', agentLicensesRoutes);
router.use('/enrollment-link-templates', agentEnrollmentLinkTemplatesRoutes);
router.use('/enrollment-links', agentEnrollmentLinksRoutes);
router.use('/onboarding-links', agentOnboardingLinksRoutes);
router.use('/agents', agentAgentsRoutes);
router.use('/commission-rules', agentCommissionRulesRoutes);
router.use('/payouts', agentPayoutsRoutes);
router.use('/payments', agentPaymentsRoutes);
router.use('/payment-processor-status', agentPaymentProcessorStatusRoutes);
router.use('/training', agentTrainingRoutes);
router.use('/marketing-resources', agentMarketingResourcesRoutes);
router.use('/agencies', agentAgenciesRoutes);
router.use('/agencies/:agencyId', agentAgencyResourceLibraryRoutes);
router.use('/', agentGroupOnboardingRoutes); // Group onboarding routes (e.g., /groups/:groupId/onboarding-link)

console.log('✅ Mounted /api/me/agent routes (groups, members, products, tenant, profile, bank-info, licenses, enrollment-link-templates, enrollment-links, onboarding-links, agents, commission-rules, marketing-resources, group-onboarding)');
router.use('/billing', agentBillingRoutes);
router.use('/assignable-agents', agentAssignableAgentsRoutes);
router.use('/group-type-change-requests', agentGroupTypeChangeRequestsRoutes);
router.use('/marketing-link', agentMarketingLinkRoutes);
router.use('/notification-preferences', agentNotificationPreferencesRoutes);
router.use('/', agentGroupOnboardingRoutes); // Group onboarding routes (e.g., /groups/:groupId/onboarding-link)

console.log('✅ Mounted /api/me/agent routes (groups, members, products, tenant, profile, bank-info, licenses, enrollment-link-templates, enrollment-links, onboarding-links, agents, commission-rules, group-onboarding, billing, assignable-agents)');

module.exports = router; 