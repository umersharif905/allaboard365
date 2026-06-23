const express = require('express');
const router = express.Router();
const { authorize } = require('../../../middleware/auth');
const { attachMemberHouseholdContext } = require('../../../middleware/attachMemberHouseholdContext');

// Apply role authorization to all routes in this router
// Allow Member role plus admin roles (SysAdmin, TenantAdmin, Agent, AgencyOwner, GroupAdmin) for routes that support admin management
router.use(authorize(['Member', 'SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']));
router.use(attachMemberHouseholdContext);
console.log('✅ Applied role authorization to all member routes (Member + Admin roles)');

// Import route modules
const profileRoutes = require('./profile');
const householdRoutes = require('./household');
const enrollmentRoutes = require('./enrollments');
const productRoutes = require('./products');
const pricingRoutes = require('./pricing');
const planChangesRoutes = require('./plan-changes');
const productChangesRoutes = require('./product-changes');
const productChangesCompleteRoutes = require('./product-changes-complete');
const checkFuturePaymentStatusRoutes = require('./check-future-payment-status');
const calculatePlanChangeCostRoutes = require('./calculate-plan-change-cost');
const documentsRoutes = require('./documents');
const paymentsRoutes = require('./payments');
const paymentMethodsRoutes = require('./payment-methods');
const tenantRoutes = require('./tenant');
const vendorNavigationRoutes = require('./vendor-navigation');
const memberTrainingRoutes = require('./training');
const telemedicineRoutes = require('./telemedicine');

// Mount routes
router.use('/profile', profileRoutes);
router.use('/household', householdRoutes);
router.use('/enrollments', enrollmentRoutes);
router.use('/products', productRoutes);
router.use('/pricing', pricingRoutes);
router.use('/plan-changes', planChangesRoutes);
router.use('/product-changes', productChangesRoutes);
router.use('/product-changes-complete', productChangesCompleteRoutes);
router.use('/check-future-payment-status', checkFuturePaymentStatusRoutes);
router.use('/calculate-plan-change-cost', calculatePlanChangeCostRoutes);
router.use('/documents', documentsRoutes);
router.use('/payments', paymentsRoutes);
router.use('/payment-methods', paymentMethodsRoutes);
router.use('/invoices', require('./invoice-pay'));
router.use('/tenant', tenantRoutes);
router.use('/vendor-navigation', vendorNavigationRoutes);
router.use('/training', memberTrainingRoutes);
router.use('/email-verification', require('./email-verification'));
router.use(telemedicineRoutes);

// Member-side forms (authenticated invitation flow)
router.use('/forms', require('./forms'));

// Member sharing requests
router.use('/sharing-requests', require('./sharing-requests'));
router.use('/communication-preferences', require('./communication-preferences'));
router.use('/medical-needs-requests', require('./medical-needs-requests'));
// router.use('/group', require('./group')); // Member's group info
// router.use('/agent', require('./agent')); // Member's agent info
// router.use('/banking', require('./banking')); // Banking information

// Phase 1e: read-only credit ledger for member's household
router.use('/household-credits', require('./household-credits'));

// Wallet pass generation (Apple Wallet / Google Wallet)
router.use('/wallet', require('./wallet'));

module.exports = router;