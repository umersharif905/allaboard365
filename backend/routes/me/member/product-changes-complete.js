// backend/routes/me/member/product-changes-complete.js
/**
 * Member Product Changes Completion Endpoint
 * 
 * Handles member-initiated plan changes including enrollment management,
 * payment calculation, and DIME payment processing.
 * 
 * IMPORTANT: See docs/billing/plan-changes-logic.md for complete documentation on:
 * - Future enrollment handling and payment logic
 * - Incremental vs full charge calculation
 * - Bundle component conflict resolution
 * - Payment amount verification
 * - Testing scenarios and edge cases
 * 
 * Frontend: frontend/src/pages/member/ProductChangeWizard.tsx
 */

// Only load .env file in development - production and qa use Azure App Service environment variables
if (process.env.NODE_ENV === 'development') {
    require('dotenv').config();
}
const express = require('express');
const sql = require('mssql');
const { getPool } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const { getEffectiveUserId, isSpouseDelegate } = require('../../../middleware/attachMemberHouseholdContext');
const { EnrollmentCompletionService } = require('../../../services/EnrollmentCompletionService');
const DimeService = require('../../../services/dimeService');
const PaymentDatabaseService = require('../../../services/paymentDatabaseService');
const { resolveAchRoutingForCharge } = require('../../../utils/achRouting');
const PricingEngine = require('../../../services/pricing/PricingEngine');
const { sameProductId } = require('../../../utils/productIdMatch');
const ContributionCalculator = require('../../../services/pricing/ContributionCalculator');
const PlanChangeCalculator = require('../../../services/PlanChangeCalculator');
const GroupPaymentService = require('../../../services/groupPaymentService');
const {
  calculateNextEffectiveDate,
  calculateTerminationDate,
  calculateEndOfCurrentMonth,
  calculateEndOfCurrentPeriod,
  checkForFutureEnrollments
} = require('../../../utils/enrollmentDateHelpers');
const { getMemberAgeForPricing } = require('../../../utils/memberAgeFromDob');
const { getHouseholdCohort } = require('../../../services/householdCohort.service');
const { formatAndEncryptSSN } = require('../../../services/members/dependentsWriter.service');

const router = express.Router();

// POST /api/me/member/product-changes-complete - Complete product changes with acknowledgements and signatures
// Handles ALL scenarios: remove products, add products, update configurations
// Supports admin roles managing other members via targetMemberId in request body
router.post('/', authorize(['Member', 'SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), async (req, res) => {
  // Set a timeout for the entire request
  const requestTimeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(408).json({
        success: false,
        message: 'Request timeout - product changes took too long to process'
      });
    }
  }, 30000); // 30 second timeout

  try {
    if (isSpouseDelegate(req)) {
      console.log('[product-changes-complete] spouse delegate acting for primary household', {
        actorUserId: req.memberContext?.actorUserId,
        effectiveMemberId: req.memberContext?.effectiveMemberId,
      });
    }

    const {
      selectedProducts,
      removedProducts = [],
      configValues = {},
      initialConfigValues = {}, // Original config values (what was enrolled before changes)
      effectiveDate,
      frontendPricing = [],
      acknowledgements = [],
      digitalSignature = '',
      memberInfo = {},
      paymentMethod = null, // Payment method info from frontend
      ipAddress = '127.0.0.1',
      userAgent = '',
      // Wizard-specific fields for dependent/tier changes
      dependentsToAdd = [],
      dependentsToRemove = [],
      newTobaccoUse = null, // Optional: only if changed
      calculatedTier = null, // Optional: auto-calculated from new household
      isGroupMember = false, // Flag to skip DIME payment processing for group members
      // Payment verification - amounts user was shown on confirmation page
      expectedChargeAmount = null,
      expectedIsIncremental = null,
      expectedMonthlyTotal = null,
      // Member ID for admin/agent managing another member's plan
      memberId: targetMemberId = null
    } = req.body;

    // Initialize payment method info for response
    let paymentMethodInfo = null;
    let actualChargeAmount = 0;
    let actualIsIncremental = false;
    let futureEnrollmentsAlreadyPaid = false;
    let paymentProcessingData = null; // Store for post-commit payment processing
    let hasEnrollments = false; // Track if any enrollments were created/updated

    console.log('🔍 Product changes completion request:', {
      selectedProductsCount: selectedProducts?.length || 0,
      selectedProducts: selectedProducts,
      removedProductsCount: removedProducts?.length || 0,
      removedProducts: removedProducts,
      hasAcknowledgements: acknowledgements?.length > 0,
      acknowledgements: acknowledgements,
      hasDigitalSignature: !!digitalSignature,
      digitalSignature: digitalSignature,
      hasConfigValues: Object.keys(configValues || {}).length > 0,
      configValues: configValues,
      hasInitialConfigValues: Object.keys(initialConfigValues || {}).length > 0,
      initialConfigValues: initialConfigValues,
      effectiveDate: effectiveDate,
      paymentMethod: paymentMethod,
      // Wizard-specific fields
      dependentsToAddCount: dependentsToAdd?.length || 0,
      dependentsToRemoveCount: dependentsToRemove?.length || 0,
      newTobaccoUse: newTobaccoUse,
      calculatedTier: calculatedTier,
      isGroupMember: isGroupMember
    });

    // Validate required data
    if (!selectedProducts || !Array.isArray(selectedProducts)) {
      return res.status(400).json({
        success: false,
        message: 'Selected products are required'
      });
    }

    if (!effectiveDate) {
      return res.status(400).json({
        success: false,
        message: 'Effective date is required'
      });
    }

    // Validate acknowledgements if provided
    if (acknowledgements && acknowledgements.length > 0) {
      if (!digitalSignature || digitalSignature.trim() === '') {
        return res.status(400).json({
          success: false,
          message: 'Digital signature is required when acknowledgements are provided'
        });
      }

      // Validate acknowledgement structure
      for (const acknowledgement of acknowledgements) {
        if (!acknowledgement.productId || !acknowledgement.questionId || acknowledgement.response === undefined) {
          return res.status(400).json({
            success: false,
            message: 'Invalid acknowledgement data: productId, questionId, and response are required'
          });
        }
      }
    }

    const pool = await getPool();
    const transaction = pool.transaction();

    try {
      // 🔒 ACID COMPLIANCE: Set isolation level to SERIALIZABLE
      // This prevents dirty reads, non-repeatable reads, and phantom reads
      // Critical for payment processing to ensure no race conditions
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      
      console.log('🔒 Transaction started with SERIALIZABLE isolation level');

      // 1. Get member information first to determine if they're in a group
      // If targetMemberId is provided (admin/agent managing another member), use that
      // Otherwise, use the logged-in user's member ID
      let actualMemberId = null;
      
      if (targetMemberId) {
        // Admin/agent/GroupAdmin managing another member - validate authorization
        console.log(`🔍 Admin/agent/GroupAdmin managing member: ${targetMemberId}, role: ${req.user.currentRole}`);
        
        // Build authorization check query based on role
        let authCheckQuery = `
          SELECT m.MemberId, m.TenantId, m.GroupId
          FROM oe.Members m
          WHERE m.MemberId = @targetMemberId
            AND m.TenantId = @userTenantId
        `;
        const authCheckRequest = transaction.request();
        authCheckRequest.input('targetMemberId', sql.UniqueIdentifier, targetMemberId);
        authCheckRequest.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        
        // For GroupAdmin: Add group filtering
        if (req.user.currentRole === 'GroupAdmin') {
          // Get GroupAdmin's group ID
          let userGroupId = req.user.GroupId || req.user.groupId;
          
          // If GroupId not in JWT, query from GroupAdmins table
          if (!userGroupId) {
            const groupIdQuery = `
              SELECT GroupId 
              FROM oe.GroupAdmins 
              WHERE UserId = @userId AND Status = 'Active'
            `;
            const groupIdRequest = transaction.request();
            groupIdRequest.input('userId', sql.UniqueIdentifier, getEffectiveUserId(req));
            const groupIdResult = await groupIdRequest.query(groupIdQuery);
            
            if (groupIdResult.recordset.length > 0 && groupIdResult.recordset[0].GroupId) {
              userGroupId = groupIdResult.recordset[0].GroupId;
            }
          }
          
          if (userGroupId) {
            authCheckQuery += ' AND m.GroupId = @userGroupId';
            authCheckRequest.input('userGroupId', sql.UniqueIdentifier, userGroupId);
          } else {
            await transaction.rollback();
            return res.status(403).json({
              success: false,
              message: 'Access denied: No group assigned',
              code: 'NO_GROUP_ASSIGNED'
            });
          }
        }
        
        const authCheckResult = await authCheckRequest.query(authCheckQuery);
        
        if (authCheckResult.recordset.length === 0) {
          await transaction.rollback();
          return res.status(403).json({
            success: false,
            message: 'You do not have permission to manage this member'
          });
        }
        
        actualMemberId = targetMemberId;
      } else {
        // Regular member managing their own plan
        actualMemberId = null; // Will use userId lookup
      }
      
      const memberQuery = actualMemberId
        ? `
          SELECT 
            m.MemberId,
            m.UserId,
            m.TenantId,
            m.DateOfBirth,
            m.TobaccoUse,
            m.Tier,
            m.AgentId,
            m.GroupId,
            m.HouseholdId,
            u.FirstName,
            u.LastName,
            u.Email
          FROM oe.Members m
          JOIN oe.Users u ON m.UserId = u.UserId
          WHERE m.MemberId = @memberId
        `
        : `
          SELECT 
            m.MemberId,
            m.UserId,
            m.TenantId,
            m.DateOfBirth,
            m.TobaccoUse,
            m.Tier,
            m.AgentId,
            m.GroupId,
            m.HouseholdId,
            u.FirstName,
            u.LastName,
            u.Email
          FROM oe.Members m
          JOIN oe.Users u ON m.UserId = u.UserId
          WHERE m.UserId = @userId
        `;

      const memberRequest = transaction.request();
      if (actualMemberId) {
        memberRequest.input('memberId', sql.UniqueIdentifier, actualMemberId);
      } else {
        memberRequest.input('userId', sql.UniqueIdentifier, getEffectiveUserId(req));
      }
      const memberResult = await memberRequest.query(memberQuery);

      if (memberResult.recordset.length === 0) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: 'Member not found'
        });
      }

      const member = memberResult.recordset[0];
      const isGroupMember = member.GroupId !== null;

      // 2. Check for valid payment method FIRST (before any database changes)
      if (!isGroupMember) {
        console.log('🔍 Checking for active payment method before processing changes...');
        
        const paymentMethodQuery = `
          SELECT TOP 1 
            PaymentMethodId, 
            Status, 
            ExpiryMonth, 
            ExpiryYear,
            ProcessorCustomerId,
            ProcessorPaymentMethodId,
            BillingAddress,
            BillingCity,
            BillingState,
            BillingZip
          FROM oe.MemberPaymentMethods 
          WHERE MemberId = @memberId AND Status = 'Active'
        `;
        
        const paymentMethodRequest = transaction.request();
        paymentMethodRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
        const paymentMethodResult = await paymentMethodRequest.query(paymentMethodQuery);
        
        if (paymentMethodResult.recordset.length === 0) {
          await transaction.rollback();
          console.log('❌ No active payment method found for member');
          return res.status(400).json({
            success: false,
            message: 'Payment setup required: Please add a payment method in your account settings before making plan changes.'
          });
        }
        
        const paymentMethod = paymentMethodResult.recordset[0];
        
        // ✅ STRICT VALIDATION: Check for complete DIME setup
        if (!paymentMethod.ProcessorCustomerId || !paymentMethod.ProcessorPaymentMethodId) {
          await transaction.rollback();
          console.log('❌ Payment method missing DIME processor setup:', {
            hasCustomerId: !!paymentMethod.ProcessorCustomerId,
            hasPaymentMethodId: !!paymentMethod.ProcessorPaymentMethodId
          });
          return res.status(400).json({
            success: false,
            message: 'Payment method setup incomplete: Your payment method is missing required payment processor information. Please re-add your payment method in your account settings.'
          });
        }
        
        // ✅ STRICT VALIDATION: Check for complete billing address
        if (!paymentMethod.BillingAddress || !paymentMethod.BillingCity || !paymentMethod.BillingState || !paymentMethod.BillingZip) {
          await transaction.rollback();
          console.log('❌ Payment method missing billing address:', {
            hasAddress: !!paymentMethod.BillingAddress,
            hasCity: !!paymentMethod.BillingCity,
            hasState: !!paymentMethod.BillingState,
            hasZip: !!paymentMethod.BillingZip
          });
          return res.status(400).json({
            success: false,
            message: 'Payment method setup incomplete: Your payment method is missing required billing address information. Please update your payment method in your account settings with complete billing details.'
          });
        }
        
        // Check if payment method is expired (using month/year)
        if (paymentMethod.ExpiryMonth && paymentMethod.ExpiryYear) {
          const currentDate = new Date();
          const currentYear = currentDate.getFullYear();
          const currentMonth = currentDate.getMonth() + 1; // getMonth() returns 0-11, we need 1-12
          
          const isExpired = paymentMethod.ExpiryYear < currentYear || 
                           (paymentMethod.ExpiryYear === currentYear && paymentMethod.ExpiryMonth < currentMonth);
          
          if (isExpired) {
            await transaction.rollback();
            console.log('❌ Payment method is expired:', `${paymentMethod.ExpiryMonth}/${paymentMethod.ExpiryYear}`);
            return res.status(400).json({
              success: false,
              message: 'Payment method expired: Please update your payment method in your account settings before making plan changes.'
            });
          }
        }
        
        console.log('✅ Active payment method found:', paymentMethod.PaymentMethodId);
      }
      
      // Check for future-effective enrollments and determine if they're already paid for
      // Include both Active and Pending status enrollments with future effective dates
      console.log('🔍 Checking for future enrollments...');
      
      const futureEnrollmentsQuery = `
        SELECT 
          ProductId, 
          ProductBundleID, 
          EffectiveDate,
          PremiumAmount,
          Status
        FROM oe.Enrollments
        WHERE MemberId = @memberId 
          AND (Status = 'Active' OR Status = 'Pending')
          AND EffectiveDate > GETDATE()
          AND (TerminationDate IS NULL OR TerminationDate > GETDATE())
          AND (EnrollmentType = 'Product' OR EnrollmentType IS NULL)
      `;
      
      const futureEnrollmentsRequest = transaction.request();
      futureEnrollmentsRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
      const futureEnrollmentsResult = await futureEnrollmentsRequest.query(futureEnrollmentsQuery);
      
      const futureEnrollments = futureEnrollmentsResult.recordset;
      const hasFutureEnrollments = futureEnrollments.length > 0;
      const futureEffectiveDate = hasFutureEnrollments ? futureEnrollments[0].EffectiveDate : null;
      
      // Get list of products already enrolled in future
      const futureEnrolledProductIds = new Set();
      futureEnrollments.forEach(e => {
        if (e.ProductBundleID) {
          futureEnrolledProductIds.add(e.ProductBundleID);
        } else {
          futureEnrolledProductIds.add(e.ProductId);
        }
      });
      
      // Check if future enrollments are already paid for by checking next recurring payment date
      let nextRecurringPaymentDate = null;
      
      if (hasFutureEnrollments) {
        console.log(`✅ Found ${futureEnrollments.length} future enrollments effective ${futureEffectiveDate.toISOString().split('T')[0]}`);
        console.log('📋 Future enrolled products:', Array.from(futureEnrolledProductIds).map(id => id.substring(0, 8)));
        
        // Get member's household ID to check DIME recurring payment schedule
        const householdQuery = `
          SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId
        `;
        
        const householdResult = await transaction.request()
          .input('memberId', sql.UniqueIdentifier, member.MemberId)
          .query(householdQuery);
        
        if (householdResult.recordset.length > 0 && householdResult.recordset[0].HouseholdId) {
          const householdId = householdResult.recordset[0].HouseholdId;
          
          // Get next recurring payment date from DIME
          console.log(`🔍 Checking DIME recurring schedule for household: ${householdId}, tenant: ${member.TenantId}`);
          const recurringSchedule = await DimeService.getRecurringPaymentSchedule(householdId, member.TenantId);
          
          console.log('🔍 DIME recurring schedule response:', {
            success: recurringSchedule.success,
            nextRunDate: recurringSchedule.nextRunDate,
            error: recurringSchedule.error,
            fullResponse: recurringSchedule
          });
          
          if (recurringSchedule.success && recurringSchedule.nextRunDate) {
            nextRecurringPaymentDate = new Date(recurringSchedule.nextRunDate);
            
            console.log(`📅 Next recurring payment date: ${nextRecurringPaymentDate.toISOString().split('T')[0]}`);
            console.log(`📅 Future enrollments effective date: ${futureEffectiveDate.toISOString().split('T')[0]}`);
            
            // If next payment is AFTER future effective date, then future enrollments are already paid for
            if (nextRecurringPaymentDate > futureEffectiveDate) {
              futureEnrollmentsAlreadyPaid = true;
              console.log('✅ Future enrollments ARE already paid for (next payment is after effective date)');
              console.log('💡 Will use incremental charging for new products');
            } else {
              console.log('✅ Future enrollments NOT yet paid for (next payment is before/on effective date)');
              console.log('💡 Will use normal full charging');
            }
          } else {
            // DIME service didn't find a recurring schedule - fallback to checking oe.Payments table directly
            console.log('⚠️ No DIME recurring schedule found - checking oe.Payments table as fallback...');
            
            const paymentsCheckQuery = `
              SELECT TOP 1
                p.NextBillingDate,
                p.RecurringScheduleId,
                p.Amount,
                p.Status
              FROM oe.Payments p
              WHERE p.HouseholdId = @householdId
                AND p.Status IN ('succeeded', 'APPROVAL', 'Completed')
              ORDER BY p.CreatedDate DESC
            `;
            
            const paymentsCheckRequest = transaction.request();
            const paymentsCheckResult = await paymentsCheckRequest
              .input('householdId', sql.UniqueIdentifier, householdId)
              .query(paymentsCheckQuery);
            
            if (paymentsCheckResult.recordset.length > 0) {
              const payment = paymentsCheckResult.recordset[0];
              
              console.log('💰 Found payment record in oe.Payments:', {
                status: payment.Status,
                amount: payment.Amount,
                hasRecurringSchedule: !!payment.RecurringScheduleId,
                nextBillingDate: payment.NextBillingDate
              });
              
              // Check if recurring schedule exists AND next billing date exists
              if (payment.RecurringScheduleId && payment.NextBillingDate) {
                const nextBillingDate = new Date(payment.NextBillingDate);
                
                // If next billing is AFTER effective date, first month is already paid
                futureEnrollmentsAlreadyPaid = nextBillingDate > futureEffectiveDate;
                
                console.log(`💡 Payment schedule check: next billing ${nextBillingDate.toISOString().split('T')[0]} vs effective ${futureEffectiveDate.toISOString().split('T')[0]} = ${futureEnrollmentsAlreadyPaid ? 'PAID' : 'NOT PAID'}`);
              } else {
                // Payment exists but no recurring schedule - first month IS paid, recurring not set up yet
                console.log('⚠️ Payment exists but no recurring schedule - treating as PAID (will need recurring setup)');
                futureEnrollmentsAlreadyPaid = true;
              }
            } else {
              // No payment found at all
              console.log('⚠️ No payment found in oe.Payments - defaulting to FULL CHARGE');
              futureEnrollmentsAlreadyPaid = false;
            }
          }
        }
      } else {
        console.log('✅ No future enrollments found - normal plan change flow');
      }
      
      // Get all active enrollments (current AND future effective dates)
      // IMPORTANT: Include future enrollments to prevent duplicate creation during plan changes
      // Only include Product enrollments (exclude Contribution, PaymentProcessingFee, SystemFee, etc.)
      // Include both Active and Pending status enrollments
      const currentEnrollmentsCheckQuery = `
        SELECT DISTINCT ProductId, ProductBundleID, EffectiveDate, Status
        FROM oe.Enrollments
        WHERE MemberId = @memberId 
          AND (Status = 'Active' OR Status = 'Pending')
          AND (TerminationDate IS NULL OR TerminationDate > GETDATE())
          AND (EnrollmentType = 'Product' OR EnrollmentType IS NULL)
      `;
      const currentEnrollmentsCheckRequest = transaction.request();
      currentEnrollmentsCheckRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
      const currentEnrollmentsCheckResult = await currentEnrollmentsCheckRequest.query(currentEnrollmentsCheckQuery);
      
      const currentlyEnrolledProductIds = new Set();
      currentEnrollmentsCheckResult.recordset.forEach(e => {
        if (e.ProductBundleID) {
          currentlyEnrolledProductIds.add(e.ProductBundleID); // Bundle product
        } else {
          currentlyEnrolledProductIds.add(e.ProductId); // Individual product
        }
      });
      
      // Only check products that are ALREADY ENROLLED AND have config changes (not just being kept as-is)
      // First, get the current configurations from all active enrollments (current AND future)
      // Only include Product enrollments (exclude Contribution, PaymentProcessingFee, SystemFee, etc.)
      const currentConfigsQuery = `
        SELECT ProductId, ProductBundleID, EnrollmentDetails, EffectiveDate
        FROM oe.Enrollments
        WHERE MemberId = @memberId 
          AND Status = 'Active'
          AND (TerminationDate IS NULL OR TerminationDate > GETDATE())
          AND (EnrollmentType = 'Product' OR EnrollmentType IS NULL)
      `;
      const currentConfigsRequest = transaction.request();
      currentConfigsRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
      const currentConfigsResult = await currentConfigsRequest.query(currentConfigsQuery);
      
      const currentConfigurations = new Map();
      currentConfigsResult.recordset.forEach(e => {
        const productId = e.ProductBundleID || e.ProductId;
        try {
          if (e.EnrollmentDetails) {
            const details = JSON.parse(e.EnrollmentDetails);
            currentConfigurations.set(productId, details.configuration || 'Default');
          } else {
            // No enrollment details means it's a Default config
            currentConfigurations.set(productId, 'Default');
          }
        } catch (err) {
          // If we can't parse, assume Default config
          currentConfigurations.set(productId, 'Default');
        }
      });
      
      console.log('🔍 Current configurations from database:', Array.from(currentConfigurations.entries()));
      
      // ✅ FIXED: Now correctly detects both bundle-level AND sub-product config changes
      // This allows users to modify future enrollment configurations with proper "Due Today" calculation
      // Only check products that are ALREADY ENROLLED AND have actual config changes
      // IMPORTANT: Check for BOTH bundle-level AND sub-product-level config changes
      const productsBeingModified = selectedProducts.filter(pid => {
        const isAlreadyEnrolled = currentlyEnrolledProductIds.has(pid);
        const isNotBeingRemoved = !removedProducts.includes(pid);
        
        if (!isAlreadyEnrolled || !isNotBeingRemoved) {
          return false; // Not enrolled or being removed - not a modification
        }
        
        // Check if configuration is actually changing
        // First check bundle-level config
        const currentConfig = currentConfigurations.get(pid) || 'Default';
        const newConfig = configValues[pid] || 'Default';
        const bundleLevelChange = newConfig !== currentConfig;
        
        // Also check for sub-product config changes (format: {bundleId}-{subProductId})
        // Look through ALL config keys to find any that start with this product ID
        let subProductConfigChange = false;
        for (const [configKey, newValue] of Object.entries(configValues)) {
          // Check if this is a sub-product config key for this bundle
          if (configKey.startsWith(pid + '-') && configKey !== pid) {
            // Compare with initial config value
            const oldValue = initialConfigValues[configKey] || 'Default';
            if (newValue !== oldValue) {
              subProductConfigChange = true;
              console.log(`🔍 Sub-product config change detected for bundle ${pid.substring(0, 8)}:`, {
                configKey: configKey.substring(0, 50),
                oldValue,
                newValue
              });
              break;
            }
          }
        }
        
        const hasConfigChange = bundleLevelChange || subProductConfigChange;
        
        console.log(`🔍 Checking ${pid.substring(0, 8)}:`, {
          currentConfig,
          newConfig,
          bundleLevelChange,
          subProductConfigChange,
          hasConfigChange
        });
        
        return hasConfigChange;
      });
      
      console.log('🔍 Products being modified (already enrolled + config change):', {
        currentlyEnrolledProductIds: Array.from(currentlyEnrolledProductIds),
        currentConfigurations: Array.from(currentConfigurations.entries()),
        selectedProducts,
        configValues,
        productsBeingModified
      });
      
      // ✅ PRODUCT CHANGE WIZARD: Allow modifications to future enrollments with restrictions
      // NEW: Validate group member same-month restriction per plan-changes-logic.md
      if (hasFutureEnrollments && isGroupMember && productsBeingModified.length > 0) {
        console.log('🔍 Checking group member same-month restriction for future enrollment modifications...');
        
        const today = new Date();
        const todayYear = today.getFullYear();
        const todayMonth = today.getMonth();
        
        // Check if any future enrollment being modified is in the same month as today
        const restrictedEnrollments = futureEnrollments.filter(enrollment => {
          const effectiveDate = new Date(enrollment.EffectiveDate);
          const effectiveYear = effectiveDate.getFullYear();
          const effectiveMonth = effectiveDate.getMonth();
          
          // Same month restriction: cannot modify if effective date is in same month as today
          return effectiveYear === todayYear && effectiveMonth === todayMonth;
        });
        
        if (restrictedEnrollments.length > 0) {
          await transaction.rollback();
          const restrictedProductNames = restrictedEnrollments.map(e => e.ProductName || 'Unknown').join(', ');
          return res.status(400).json({
            success: false,
            message: 'Cannot modify future effective plans within the same month as the effective date',
            error: `The group has already been invoiced for the following future enrollments: ${restrictedProductNames}. Modifications cannot be made within the same month as the effective date.`,
            code: 'FUTURE_ENROLLMENT_SAME_MONTH_RESTRICTION'
          });
        }
        
        console.log('✅ Group member future enrollment modification allowed (not in same month)');
      }
      
      console.log('✅ Product change wizard allows modifications to future enrollments (with restrictions)');

      // For individual members, validate payment method exists (group members skip this)
      if (!isGroupMember) {
        const paymentValidation = await validateDimePaymentExists(member.MemberId);
        const hasExistingPayment = paymentValidation.exists;
        
        if (!paymentValidation.exists) {
          console.log('❌ No payment method found for individual member - product changes blocked');
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: 'Payment method required for product changes',
            error: 'No active payment method found. Please set up a payment method before making product changes.'
          });
        }
      } else {
        console.log('✅ Member is part of a group - skipping individual payment processing');
      }

      // Validate frontend pricing matches backend calculation
      if (frontendPricing && frontendPricing.length > 0) {
        console.log('🔍 Validating frontend pricing against backend calculation...');
        console.log('🔍 DEBUG: Frontend pricing data:', frontendPricing);
        console.log('🔍 DEBUG: Selected products:', selectedProducts);
        console.log('🔍 DEBUG: Config values:', configValues);
        
        try {
          // Calculate backend pricing for validation (pass calculated tier/tobacco from wizard)
          const backendPricing = await calculateBackendPricing(
            selectedProducts, 
            configValues, 
            member.MemberId, 
            effectiveDate,
            calculatedTier, // Pass wizard tier override
            newTobaccoUse,  // Pass wizard tobacco override
            dependentsToAdd || [], // Pass dependents being added for prospective household calculation
            dependentsToRemove || [] // Pass dependents being removed for prospective household calculation
          );
          
          // Compare frontend vs backend pricing
          const pricingValidation = validatePricingMatch(frontendPricing, backendPricing);
          
          if (!pricingValidation.isValid) {
            console.error('❌ Pricing validation failed:', pricingValidation.errors);
            await transaction.rollback();
            return res.status(400).json({
              success: false,
              message: 'Pricing validation failed - frontend and backend amounts do not match',
              errors: pricingValidation.errors,
              frontendPricing: frontendPricing,
              backendPricing: backendPricing
            });
          }
          
          console.log('✅ Pricing validation passed - frontend and backend amounts match');
        } catch (pricingError) {
          console.error('❌ Error validating pricing:', pricingError);
          await transaction.rollback();
          return res.status(500).json({
            success: false,
            message: 'Failed to validate pricing - please try again',
            error: pricingError.message
          });
        }
      }

      // STEP 1: Process dependent changes (if any from wizard)
      // CRITICAL: Always calculate tier from household composition, never trust frontend's calculatedTier
      // This ensures we always have the correct tier based on actual household composition
      let finalCalculatedTier = null;
      const householdQueryForTier = `
        SELECT MemberId, RelationshipType,
          CASE WHEN MemberId = @memberId THEN 1 ELSE 0 END as IsPrimary
        FROM oe.Members
        WHERE HouseholdId = @householdId
          AND Status = 'Active'
      `;
      const householdRequestForTier = transaction.request();
      householdRequestForTier.input('memberId', sql.UniqueIdentifier, member.MemberId);
      householdRequestForTier.input('householdId', sql.UniqueIdentifier, member.HouseholdId);
      const householdResultForTier = await householdRequestForTier.query(householdQueryForTier);
      const householdMembersForTier = householdResultForTier.recordset;
      const TierCalculator = require('../../../services/pricing/TierCalculator');
      finalCalculatedTier = TierCalculator.calculateTierFromHousehold(householdMembersForTier, member.MemberId);
      console.log(`📊 Calculated tier from household: ${finalCalculatedTier} (household size: ${householdMembersForTier.length}, frontend sent: ${calculatedTier || 'null'})`);
      
      if (dependentsToAdd.length > 0 || dependentsToRemove.length > 0 || newTobaccoUse !== null || calculatedTier !== null) {
        console.log('🔍 Processing dependent/tier changes from wizard...');
        
        // Add new dependents
        if (dependentsToAdd.length > 0) {
          console.log(`📝 Adding ${dependentsToAdd.length} dependent(s)...`);
          
          for (const dependent of dependentsToAdd) {
            const newUserId = require('crypto').randomUUID();
            const newMemberId = require('crypto').randomUUID();
            
            // Handle email: Generate unique email if empty or same as primary member
            let dependentEmail = dependent.email;
            
            // Normalize both emails for comparison (trim, lowercase)
            const normalizedDependentEmail = (dependentEmail || '').trim().toLowerCase();
            const normalizedMemberEmail = (member.Email || '').trim().toLowerCase();
            
            console.log(`🔍 Email comparison:`, {
              dependentEmail: normalizedDependentEmail,
              memberEmail: normalizedMemberEmail,
              areEqual: normalizedDependentEmail === normalizedMemberEmail
            });
            
            // Generate unique email if: empty, whitespace-only, or matches primary member
            if (!dependentEmail || dependentEmail.trim() === '' || normalizedDependentEmail === normalizedMemberEmail) {
              dependentEmail = `dependent-${newUserId}@noemail.com`;
              console.log(`📧 Generated unique email for dependent: ${dependentEmail}`);
            } else {
              console.log(`📧 Using provided email for dependent: ${dependentEmail}`);
            }
            
            // Create user account for dependent
            const userInsertRequest = transaction.request();
            userInsertRequest.input('userId', sql.UniqueIdentifier, newUserId);
            userInsertRequest.input('firstName', sql.NVarChar(100), dependent.firstName);
            userInsertRequest.input('lastName', sql.NVarChar(100), dependent.lastName);
            userInsertRequest.input('email', sql.NVarChar(255), dependentEmail);
            userInsertRequest.input('phoneNumber', sql.NVarChar(20), dependent.phone || null);
            userInsertRequest.input('status', sql.NVarChar(50), 'Active');
            userInsertRequest.input('tenantId', sql.UniqueIdentifier, member.TenantId || null);
            
            await userInsertRequest.query(`
              INSERT INTO oe.Users (
                UserId, Email, FirstName, LastName, PhoneNumber, 
                Status, TenantId, CreatedDate, ModifiedDate
              ) VALUES (
                @userId, @email, @firstName, @lastName, @phoneNumber,
                @status, @tenantId, GETDATE(), GETDATE()
              )
            `);
            
            // Assign Member role (manual insert to avoid nested transaction deadlock)
            const roleRequest = transaction.request();
            roleRequest.input('userRoleId', sql.UniqueIdentifier, require('crypto').randomUUID());
            roleRequest.input('userId', sql.UniqueIdentifier, newUserId);
            roleRequest.input('createdBy', sql.UniqueIdentifier, member.UserId);
            
            await roleRequest.query(`
              INSERT INTO oe.UserRoles (UserRoleId, UserId, RoleId, CreatedBy, CreatedDate)
              VALUES (
                @userRoleId,
                @userId,
                (SELECT RoleId FROM oe.Roles WHERE Name = 'Member'),
                @createdBy,
                GETDATE()
              )
            `);
            
            // Optional SSN (encrypted same as enrollment / plan-mod dependents)
            const encryptedDependentSsn = dependent.ssn ? formatAndEncryptSSN(dependent.ssn) : null;
            if (dependent.ssn && !encryptedDependentSsn) {
              await transaction.rollback();
              return res.status(400).json({
                success: false,
                message: 'Invalid Social Security Number for dependent: provide 9 digits or leave blank.'
              });
            }

            // Create member record for dependent
            const memberInsertRequest = transaction.request();
            memberInsertRequest.input('memberId', sql.UniqueIdentifier, newMemberId);
            memberInsertRequest.input('userId', sql.UniqueIdentifier, newUserId);
            memberInsertRequest.input('householdId', sql.UniqueIdentifier, member.HouseholdId);
            memberInsertRequest.input('tenantId', sql.UniqueIdentifier, member.TenantId);
            memberInsertRequest.input('groupId', sql.UniqueIdentifier, member.GroupId);
            memberInsertRequest.input('relationshipType', sql.NVarChar(10), dependent.relationshipType);
            memberInsertRequest.input('dateOfBirth', sql.Date, dependent.dateOfBirth || null);
            memberInsertRequest.input('gender', sql.NVarChar(10), dependent.gender || null);
            memberInsertRequest.input('status', sql.NVarChar(50), 'Active');
            memberInsertRequest.input('ssn', sql.NVarChar, encryptedDependentSsn);

            await memberInsertRequest.query(`
              INSERT INTO oe.Members (
                MemberId, UserId, HouseholdId, TenantId, GroupId, RelationshipType,
                DateOfBirth, Gender, Status, SSN, CreatedDate
              ) VALUES (
                @memberId, @userId, @householdId, @tenantId, @groupId, @relationshipType,
                @dateOfBirth, @gender, @status, @ssn, GETDATE()
              )
            `);
            
            console.log(`✅ Added dependent: ${dependent.firstName} ${dependent.lastName} (${dependent.relationshipType})`);
          }
        }
        
        // Remove dependents
        if (dependentsToRemove.length > 0) {
          console.log(`📝 Removing ${dependentsToRemove.length} dependent(s)...`);
          
          for (const dependentMemberId of dependentsToRemove) {
            // Soft delete - set status to Inactive
            const removeRequest = transaction.request();
            removeRequest.input('memberId', sql.UniqueIdentifier, dependentMemberId);
            removeRequest.input('modifiedDate', sql.DateTime2, new Date());
            
            await removeRequest.query(`
              UPDATE oe.Members
              SET Status = 'Inactive', ModifiedDate = @modifiedDate
              WHERE MemberId = @memberId
            `);
            
            console.log(`✅ Removed dependent: ${dependentMemberId}`);
          }
        }
        
        // Update primary member's tier and tobacco use if changed
        // Note: finalCalculatedTier was already calculated above (before dependents were added/removed)
        // Recalculate it here after dependents are added/removed to ensure it reflects the current household
        const householdQueryAfterDependents = `
          SELECT MemberId, RelationshipType,
            CASE WHEN MemberId = @memberId THEN 1 ELSE 0 END as IsPrimary
          FROM oe.Members
          WHERE HouseholdId = @householdId
            AND Status = 'Active'
        `;
        const householdRequestAfterDependents = transaction.request();
        householdRequestAfterDependents.input('memberId', sql.UniqueIdentifier, member.MemberId);
        householdRequestAfterDependents.input('householdId', sql.UniqueIdentifier, member.HouseholdId);
        const householdResultAfterDependents = await householdRequestAfterDependents.query(householdQueryAfterDependents);
        const householdMembersAfterDependents = householdResultAfterDependents.recordset;
        finalCalculatedTier = TierCalculator.calculateTierFromHousehold(householdMembersAfterDependents, member.MemberId);
        console.log(`📊 Recalculated tier from household after dependent changes: ${finalCalculatedTier} (household size: ${householdMembersAfterDependents.length})`);
        
        if (newTobaccoUse !== null || finalCalculatedTier !== null) {
          console.log('📝 Updating primary member tier/tobacco status...');
          
          const updateMemberRequest = transaction.request();
          updateMemberRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
          updateMemberRequest.input('modifiedDate', sql.DateTime2, new Date());
          
          const updateFields = [];
          if (newTobaccoUse !== null) {
            updateMemberRequest.input('tobaccoUse', sql.NVarChar(3), newTobaccoUse === 'Yes' ? 'Y' : 'N');
            updateFields.push('TobaccoUse = @tobaccoUse');
          }
          if (finalCalculatedTier !== null) {
            updateMemberRequest.input('tier', sql.NVarChar(10), finalCalculatedTier);
            updateFields.push('Tier = @tier');
          }
          
          if (updateFields.length > 0) {
            await updateMemberRequest.query(`
              UPDATE oe.Members
              SET ${updateFields.join(', ')}, ModifiedDate = @modifiedDate
              WHERE MemberId = @memberId
            `);
            
            console.log(`✅ Updated member: Tier=${finalCalculatedTier || 'unchanged'}, Tobacco=${newTobaccoUse || 'unchanged'}`);
          }
        }
      }

      // CRITICAL: Handle tier/tobacco/dependent changes for existing future enrollments
      // If tier or tobacco changed AND future enrollments exist, we need to:
      // 1. Recalculate all existing enrollments with new tier/tobacco
      // 2. Calculate the premium difference
      // 3. Terminate existing future enrollments
      // 4. They will be recreated by EnrollmentCompletionService with new pricing
      // 5. Charge the difference if already paid for
      let tierTobaccoPremiumAdjustment = 0;
      let repricedFuturePremiumTotal = 0; // Store for monthly total calculation
      
      // Calculate termination date for changes (needed for repricing and removals)
      // Cohort-aware: use the latest active Product enrollment's EffectiveDate so
      // 15th-cohort members are terminated at the 14th of next month (not end-of-calendar-month).
      const latestActiveEnrollment = currentEnrollmentsCheckResult.recordset
        .filter(e => e.Status === 'Active')
        .sort((a, b) => new Date(b.EffectiveDate) - new Date(a.EffectiveDate))[0];
      const terminationDateForChanges = calculateEndOfCurrentPeriod({
        EffectiveDate: latestActiveEnrollment?.EffectiveDate
      });
      
      // Check if tier or tobacco ACTUALLY changed (not just sent from frontend)
      // CRITICAL: Always use finalCalculatedTier (calculated from household) instead of frontend's calculatedTier
      const finalTier = finalCalculatedTier;
      const currentTobaccoNormalized = member.TobaccoUse === 'Y' ? 'Yes' : 'No';
      const newTobaccoNormalized = newTobaccoUse === 'Yes' ? 'Yes' : 'No';
      const tierActuallyChanged = finalTier !== null && finalTier !== member.Tier;
      const tobaccoActuallyChanged = newTobaccoUse !== null && newTobaccoNormalized !== currentTobaccoNormalized;
      
      console.log('🔍 Checking for tier/tobacco changes:', {
        currentTier: member.Tier,
        newTier: finalTier,
        tierChanged: tierActuallyChanged,
        currentTobacco: member.TobaccoUse,
        currentTobaccoNormalized,
        newTobacco: newTobaccoUse,
        newTobaccoNormalized,
        tobaccoChanged: tobaccoActuallyChanged
      });
      
      if ((tierActuallyChanged || tobaccoActuallyChanged) && hasFutureEnrollments) {
        console.log('🔄 Tier/tobacco ACTUALLY changed with future enrollments - calculating premium adjustment...');
        
        // Get all future enrolled products with their current premiums
        const futureEnrollmentsQuery = `
          SELECT 
            e.EnrollmentId,
            e.ProductId,
            e.ProductBundleID,
            e.PremiumAmount,
            e.EnrollmentDetails,
            p.Name as ProductName,
            p.ProductType
          FROM oe.Enrollments e
          LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
          WHERE e.MemberId = @memberId 
            AND e.Status = 'Active'
            AND e.EffectiveDate > GETDATE()
        `;
        
        const futureEnrollmentsRequest = transaction.request();
        futureEnrollmentsRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
        const futureEnrollmentsResult = await futureEnrollmentsRequest.query(futureEnrollmentsQuery);
        const futureEnrollments = futureEnrollmentsResult.recordset;
        
        // Calculate OLD total premium (what they already paid)
        const oldTotalPremium = futureEnrollments.reduce((sum, e) => sum + (e.PremiumAmount || 0), 0);
        console.log(`💰 Old total premium (already paid): $${oldTotalPremium}`);
        
        // Recalculate each enrollment with NEW tier/tobacco
        // Group by product/bundle to avoid recalculating bundle components multiple times
        const uniqueProducts = new Map();
        futureEnrollments.forEach(e => {
          const key = e.ProductBundleID || e.ProductId;
          if (!uniqueProducts.has(key)) {
            uniqueProducts.set(key, {
              productId: e.ProductBundleID || e.ProductId,
              isBundle: !!e.ProductBundleID,
              enrollmentDetails: e.EnrollmentDetails,
              currentPremium: e.PremiumAmount
            });
          } else {
            // Add component premiums for bundles
            const existing = uniqueProducts.get(key);
            existing.currentPremium += e.PremiumAmount;
          }
        });
        
        // Get new tier/tobacco values
        const tierForRepricing = calculatedTier || member.Tier || 'EE';
        const tobaccoForRepricing = newTobaccoUse || member.TobaccoUse || 'No';
        
        console.log(`🔍 Repricing ${uniqueProducts.size} product(s) with new tier/tobacco:`, {
          oldTier: member.Tier,
          newTier: tierForRepricing,
          oldTobacco: member.TobaccoUse,
          newTobacco: tobaccoForRepricing
        });
        
        // Recalculate premium for each unique product
        // NOTE: For bundles, we need to get the configuration from the COMPONENT products
        let newTotalPremium = 0;
        
        // Get household size for pricing (query once, use for all products)
        const householdSizeQuery = `
          SELECT COUNT(*) as HouseholdSize
          FROM oe.Members
          WHERE HouseholdId = (SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId)
            AND Status IN ('Active', 'Pending')
        `;
        const householdSizeRequest = transaction.request();
        householdSizeRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
        const householdSizeResult = await householdSizeRequest.query(householdSizeQuery);
        const householdSize = householdSizeResult.recordset[0]?.HouseholdSize || 1;
        
        console.log(`🔍 Household size for repricing: ${householdSize} (should include newly added dependents)`);
        
        const memberAge = getMemberAgeForPricing(member.DateOfBirth, 35);
        
        for (const [key, productInfo] of uniqueProducts) {
          // For bundles, look for component config in configValues
          // Format: {bundleId}-{componentId} = configValue
          let configValue = 'Default';
          
          if (productInfo.isBundle) {
            // Find bundle component configs (e.g., EB405DCF-F165AF93 = '1500')
            const bundleConfigKey = Object.keys(configValues).find(k => k.startsWith(productInfo.productId + '-'));
            if (bundleConfigKey) {
              configValue = configValues[bundleConfigKey];
              console.log(`  🔍 Found bundle config for ${productInfo.productId.substring(0, 8)}: ${configValue}`);
            }
          } else {
            // Individual product - get config directly
            configValue = configValues[productInfo.productId] || 'Default';
          }
          
          // Try to get from enrollment details as fallback
          if (configValue === 'Default') {
            try {
              const details = JSON.parse(productInfo.enrollmentDetails || '{}');
              if (details.configuration && details.configuration !== 'Default') {
                configValue = details.configuration;
              }
            } catch (e) {
              // Use Default
            }
          }
          
          console.log(`  🔍 Repricing ${productInfo.productId.substring(0, 8)} with:`, {
            tier: tierForRepricing,
            age: memberAge,
            tobaccoUse: tobaccoForRepricing,
            householdSize: householdSize,
            configValue: configValue,
            isBundle: productInfo.isBundle
          });
          
          try {
            // Use calculatePricing (handles bundles) instead of calculateProductPricing (individual products only)
            const repricingResult = await PricingEngine.calculatePricing({
              calculationType: 'enrollment',
              productSelections: [{
                productId: productInfo.productId,
                configValues: { configValue1: configValue }
              }],
              memberCriteria: {
                age: memberAge,
                tobaccoUse: tobaccoForRepricing,
                tier: tierForRepricing,
                householdSize: householdSize
              },
              groupId: member.GroupId || null
            });
            
            // Get the monthly premium from the repricing result
            console.log(`  🔍 Repricing result structure:`, {
              hasProducts: !!repricingResult.products,
              productsCount: repricingResult.products?.length || 0,
              hasTotals: !!repricingResult.totals,
              totalPremium: repricingResult.totals?.totalPremium
            });
            
            const repricedProduct = repricingResult.products?.find((p) =>
              sameProductId(p.productId, productInfo.productId)
            );
            const monthlyPremium = repricedProduct?.monthlyPremium || repricingResult.totals?.totalPremium || 0;
            
            newTotalPremium += monthlyPremium;
            console.log(`  ✅ Repriced ${productInfo.productId.substring(0, 8)}: $${productInfo.currentPremium} → $${monthlyPremium}`);
          } catch (repricingError) {
            console.error(`  ❌ CRITICAL: Failed to reprice ${productInfo.productId}:`, repricingError.message);
            console.error(`  🚨 Cannot proceed with tier/tobacco change - pricing engine failed`);
            
            // SECURITY: NEVER fall back to frontend pricing or old pricing!
            // If repricing fails, the entire transaction must be rolled back
            throw new Error(`Unable to calculate pricing for ${productInfo.productId} with new tier/tobacco. Please contact support.`);
          }
        }
        
        console.log(`💰 New total premium (with new tier/tobacco): $${newTotalPremium}`);
        
        // Store the repriced total for monthly calculation
        repricedFuturePremiumTotal = newTotalPremium;
        
        // Calculate the difference
        const premiumDifference = newTotalPremium - oldTotalPremium;
        console.log(`💵 Premium adjustment: ${premiumDifference >= 0 ? '+' : ''}$${premiumDifference}`);
        
        // Only charge for increases (no refunds for decreases)
        // IMPORTANT: Group members NEVER get charged - their employer pays
        if (premiumDifference > 0 && futureEnrollmentsAlreadyPaid && !isGroupMember) {
          tierTobaccoPremiumAdjustment = premiumDifference;
          console.log(`💳 Will charge additional $${tierTobaccoPremiumAdjustment} for tier/tobacco premium increase`);
        } else if (premiumDifference > 0 && isGroupMember) {
          console.log(`ℹ️ Premium increased by $${premiumDifference} - no charge (group member, employer pays)`);
        } else if (premiumDifference < 0) {
          console.log(`ℹ️ Premium decreased by $${Math.abs(premiumDifference)} - no refund, member keeps current month at higher rate`);
        } else {
          console.log(`ℹ️ No premium change from tier/tobacco adjustment`);
        }
        
        // TERMINATE all existing future enrollments
        // They will be recreated by EnrollmentCompletionService with new tier/tobacco pricing
        console.log(`🔄 Terminating ${futureEnrollments.length} future enrollments for repricing...`);
        
        for (const enrollment of futureEnrollments) {
          const terminateRequest = transaction.request();
          terminateRequest.input('enrollmentId', sql.UniqueIdentifier, enrollment.EnrollmentId);
          terminateRequest.input('terminationDate', sql.Date, terminationDateForChanges);
          terminateRequest.input('modifiedDate', sql.DateTime2, new Date());
          terminateRequest.input('modifiedBy', sql.UniqueIdentifier, member.UserId);
          
          await terminateRequest.query(`
            UPDATE oe.Enrollments 
            SET Status = 'Inactive',
                TerminationDate = @terminationDate,
                ModifiedDate = @modifiedDate,
                ModifiedBy = @modifiedBy
            WHERE EnrollmentId = @enrollmentId
          `);
          
          console.log(`  ✅ Terminated ${enrollment.ProductName} for repricing`);
        }
        
        // Add all future products to selectedProducts so they get recreated
        // Extract unique product IDs (bundle ID if bundle, otherwise product ID)
        const futureProductsToRecreate = Array.from(uniqueProducts.keys());
        
        console.log(`📋 Adding ${futureProductsToRecreate.length} future products to recreation list:`, 
          futureProductsToRecreate.map(id => id.substring(0, 8))
        );
        
        // Merge with selectedProducts (avoid duplicates)
        const mergedSelectedProducts = [...new Set([...selectedProducts, ...futureProductsToRecreate])];
        selectedProducts.length = 0;
        selectedProducts.push(...mergedSelectedProducts);
        
        // CRITICAL: Remove repriced products from currentlyEnrolledProductIds 
        // so they get recreated with new premiums
        futureProductsToRecreate.forEach(productId => {
          currentlyEnrolledProductIds.delete(productId);
        });
        
        console.log(`🔍 Updated currentlyEnrolledProductIds after removing repriced products:`, 
          Array.from(currentlyEnrolledProductIds).map(id => id.substring(0, 8))
        );
      }

      // Get household members
      const householdQuery = `
        SELECT 
          m.MemberId,
          m.RelationshipType,
          m.AgentId,
          u.FirstName,
          u.LastName
        FROM oe.Members m
        JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.HouseholdId = (
          SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId
        )
        AND m.MemberId != @memberId
      `;

      const householdRequest = transaction.request();
      householdRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
      const householdResult = await householdRequest.query(householdQuery);

      const householdMembers = householdResult.recordset;

      // Get current active enrollments for this member
      // NOTE: Only processes CURRENT enrollments (not future) for termination/config changes
      // Future enrollments are protected from termination during plan changes
      const currentEnrollmentsQuery = `
        SELECT 
          e.EnrollmentId,
          e.ProductId,
          e.EffectiveDate,
          e.PaymentFrequency,
          e.Status,
          e.PremiumAmount,
          e.EnrollmentDetails,
          e.ProductBundleID,
          p.Name as ProductName
        FROM oe.Enrollments e
        LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
        WHERE e.MemberId = @memberId 
          AND e.Status = 'Active'
          AND e.EffectiveDate <= GETDATE()
      `;

      const currentEnrollmentsRequest = transaction.request();
      currentEnrollmentsRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
      const currentEnrollmentsResult = await currentEnrollmentsRequest.query(currentEnrollmentsQuery);
      const currentEnrollments = currentEnrollmentsResult.recordset;

      // Group enrollments to determine which products are currently enrolled
      // This handles bundles correctly by showing the bundle product ID as enrolled
      // instead of showing individual bundle components as separate enrolled products
      const enrolledProductIds = new Set();
      const bundleEnrollments = new Map(); // Track bundles by ProductBundleID
      
      // Process BOTH current and future enrollments to populate bundle map
      [...currentEnrollments, ...futureEnrollments].forEach(enrollment => {
        if (enrollment.ProductBundleID) {
          // This is a bundle component enrollment
          bundleEnrollments.set(enrollment.ProductBundleID, enrollment);
        } else {
          // This is an individual product enrollment
          enrolledProductIds.add(enrollment.ProductId);
        }
      });
      
      // Add bundle product IDs to enrolled products
      bundleEnrollments.forEach((enrollment, bundleId) => {
        enrolledProductIds.add(bundleId);
      });

      console.log(`🔍 Current active enrollments (grouped):`, {
        individualProducts: Array.from(enrolledProductIds).filter(id => !bundleEnrollments.has(id)),
        bundleProducts: Array.from(bundleEnrollments.keys()),
        totalEnrolledProducts: Array.from(enrolledProductIds)
      });

      // Calculate next effective date BEFORE processing changes.
      // Household cohort lock: if the family already has active enrollments
      // (almost always true for plan changes), the new effective date must
      // match that cohort so dependents and plan changes don't drift onto
      // a different billing cycle.
      const householdCohortForPlanChange = await getHouseholdCohort(transaction, member.HouseholdId);
      const nextEffectiveDate = calculateNextEffectiveDate(member, null, null, householdCohortForPlanChange);

      console.log(`📅 Calculated dates for product changes:`, {
        nextEffectiveDate: nextEffectiveDate.toISOString().split('T')[0],
        terminationDate: terminationDateForChanges.toISOString().split('T')[0],
        householdCohort: householdCohortForPlanChange,
        isGroupMember: !!member.GroupId
      });

      // 1. Handle removed products (set to Inactive)
      // NEW: Per plan-changes-logic.md - Cancel existing plans terminate 1 month after effective date
      for (const productId of removedProducts) {
        // First, check if this is a bundle product by looking for enrollments with this ProductBundleID
        // Only check Product enrollments (exclude Contribution, PaymentProcessingFee, SystemFee, etc.)
        // Include both Active and Pending status enrollments
        const bundleCheckQuery = `
          SELECT COUNT(*) as BundleCount
          FROM oe.Enrollments 
          WHERE MemberId = @memberId 
            AND ProductBundleID = @productId
            AND (Status = 'Active' OR Status = 'Pending')
            AND (TerminationDate IS NULL OR TerminationDate > GETDATE())
            AND (EnrollmentType = 'Product' OR EnrollmentType IS NULL)
        `;
        
        const bundleCheckRequest = transaction.request();
        bundleCheckRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
        bundleCheckRequest.input('productId', sql.UniqueIdentifier, productId);
        
        const bundleCheckResult = await bundleCheckRequest.query(bundleCheckQuery);
        const isBundle = bundleCheckResult.recordset[0].BundleCount > 0;
        
        // Get the effective date of the enrollment to calculate proper termination date
        // For existing plans (not future), terminate 1 month after effective date
        // Only check Product enrollments (exclude Contribution, PaymentProcessingFee, SystemFee, etc.)
        // Include both Active and Pending status enrollments
        const getEffectiveDateQuery = isBundle
          ? `
            SELECT TOP 1 EffectiveDate, Status
            FROM oe.Enrollments 
            WHERE MemberId = @memberId 
              AND ProductBundleID = @productId
              AND (Status = 'Active' OR Status = 'Pending')
              AND (TerminationDate IS NULL OR TerminationDate > GETDATE())
              AND (EnrollmentType = 'Product' OR EnrollmentType IS NULL)
            ORDER BY EffectiveDate DESC
          `
          : `
            SELECT TOP 1 EffectiveDate, Status
            FROM oe.Enrollments 
            WHERE MemberId = @memberId 
              AND ProductId = @productId
              AND (Status = 'Active' OR Status = 'Pending')
              AND (TerminationDate IS NULL OR TerminationDate > GETDATE())
              AND (EnrollmentType = 'Product' OR EnrollmentType IS NULL)
            ORDER BY EffectiveDate DESC
          `;
        
        const effectiveDateRequest = transaction.request();
        effectiveDateRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
        effectiveDateRequest.input('productId', sql.UniqueIdentifier, productId);
        const effectiveDateResult = await effectiveDateRequest.query(getEffectiveDateQuery);
        
        let actualTerminationDate = terminationDateForChanges; // Default to end of current month
        
        if (effectiveDateResult.recordset.length > 0) {
          const enrollmentEffectiveDate = new Date(effectiveDateResult.recordset[0].EffectiveDate);
          const enrollmentStatus = effectiveDateResult.recordset[0].Status;
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const effectiveDateOnly = new Date(enrollmentEffectiveDate);
          effectiveDateOnly.setHours(0, 0, 0, 0);
          
          // Check if this is an existing plan (effective date is in the past or today)
          if (effectiveDateOnly <= today) {
            // Cancel existing plan: terminate 1 month after effective date
            const terminationDate = new Date(enrollmentEffectiveDate);
            terminationDate.setMonth(terminationDate.getMonth() + 1);
            actualTerminationDate = terminationDate;
            
            console.log(`📅 Cancel existing plan: Effective date ${enrollmentEffectiveDate.toISOString().split('T')[0]}, terminating ${actualTerminationDate.toISOString().split('T')[0]} (1 month after), Status: ${enrollmentStatus}`);
          } else {
            // Future enrollment - terminate immediately (will never go into effect)
            actualTerminationDate = new Date(); // Terminate today
            console.log(`📅 Cancel future plan: Effective date ${enrollmentEffectiveDate.toISOString().split('T')[0]} (future), terminating immediately ${actualTerminationDate.toISOString().split('T')[0]}, Status: ${enrollmentStatus}`);
          }
        }
        
        if (isBundle) {
          // Handle bundle removal: set all component enrollments with this ProductBundleID to Inactive
          // Only update Product enrollments (exclude Contribution, PaymentProcessingFee, SystemFee, etc.)
          // Include both Active and Pending status enrollments
          const bundleRemoveQuery = `
            UPDATE oe.Enrollments 
            SET Status = 'Inactive',
                TerminationDate = @terminationDate,
                ModifiedDate = @modifiedDate,
                ModifiedBy = @modifiedBy
            WHERE MemberId = @memberId 
              AND ProductBundleID = @productId
              AND (Status = 'Active' OR Status = 'Pending')
              AND (TerminationDate IS NULL OR TerminationDate > GETDATE())
              AND (EnrollmentType = 'Product' OR EnrollmentType IS NULL)
          `;
          
          const bundleRemoveRequest = transaction.request();
          bundleRemoveRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
          bundleRemoveRequest.input('productId', sql.UniqueIdentifier, productId);
          bundleRemoveRequest.input('terminationDate', sql.Date, actualTerminationDate);
          bundleRemoveRequest.input('modifiedDate', sql.DateTime2, new Date());
          bundleRemoveRequest.input('modifiedBy', sql.UniqueIdentifier, member.UserId);
          
          const bundleRemoveResult = await bundleRemoveRequest.query(bundleRemoveQuery);
          const rowsAffected = bundleRemoveResult.rowsAffected[0];
          if (rowsAffected > 0) {
            console.log(`✅ Set bundle ${productId} to Inactive (terminates: ${actualTerminationDate.toISOString().split('T')[0]}) - ${rowsAffected} enrollment(s) updated`);
          } else {
            // Try to find enrollments without the termination date check (might be future enrollments)
            const debugQuery = `
              SELECT COUNT(*) as Count, Status, EffectiveDate
              FROM oe.Enrollments 
              WHERE MemberId = @memberId 
                AND ProductBundleID = @productId
                AND (Status = 'Active' OR Status = 'Pending')
                AND (EnrollmentType = 'Product' OR EnrollmentType IS NULL)
              GROUP BY Status, EffectiveDate
            `;
            const debugRequest = transaction.request();
            debugRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
            debugRequest.input('productId', sql.UniqueIdentifier, productId);
            const debugResult = await debugRequest.query(debugQuery);
            console.warn(`⚠️ No enrollments found to cancel for bundle ${productId}. Debug info:`, debugResult.recordset);
            console.warn(`⚠️ This may indicate the bundle was already cancelled or the ProductBundleID doesn't match.`);
          }
        } else {
          // Handle individual product removal: set enrollment with this ProductId to Inactive
          // Only update Product enrollments (exclude Contribution, PaymentProcessingFee, SystemFee, etc.)
          // Include both Active and Pending status enrollments
          const individualRemoveQuery = `
            UPDATE oe.Enrollments 
            SET Status = 'Inactive',
                TerminationDate = @terminationDate,
                ModifiedDate = @modifiedDate,
                ModifiedBy = @modifiedBy
            WHERE MemberId = @memberId 
              AND ProductId = @productId
              AND (Status = 'Active' OR Status = 'Pending')
              AND (TerminationDate IS NULL OR TerminationDate > GETDATE())
              AND (EnrollmentType = 'Product' OR EnrollmentType IS NULL)
          `;
          
          const individualRemoveRequest = transaction.request();
          individualRemoveRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
          individualRemoveRequest.input('productId', sql.UniqueIdentifier, productId);
          individualRemoveRequest.input('terminationDate', sql.Date, actualTerminationDate);
          individualRemoveRequest.input('modifiedDate', sql.DateTime2, new Date());
          individualRemoveRequest.input('modifiedBy', sql.UniqueIdentifier, member.UserId);
          
          const individualRemoveResult = await individualRemoveRequest.query(individualRemoveQuery);
          const rowsAffected = individualRemoveResult.rowsAffected[0];
          if (rowsAffected > 0) {
            console.log(`✅ Set individual product ${productId} to Inactive (terminates: ${actualTerminationDate.toISOString().split('T')[0]}) - ${rowsAffected} enrollment(s) updated`);
          } else {
            // Try to find enrollments without the termination date check (might be future enrollments)
            const debugQuery = `
              SELECT COUNT(*) as Count, Status, EffectiveDate, ProductBundleID
              FROM oe.Enrollments 
              WHERE MemberId = @memberId 
                AND (ProductId = @productId OR ProductBundleID = @productId)
                AND (Status = 'Active' OR Status = 'Pending')
                AND (EnrollmentType = 'Product' OR EnrollmentType IS NULL)
              GROUP BY Status, EffectiveDate, ProductBundleID
            `;
            const debugRequest = transaction.request();
            debugRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
            debugRequest.input('productId', sql.UniqueIdentifier, productId);
            const debugResult = await debugRequest.query(debugQuery);
            console.warn(`⚠️ No enrollments found to cancel for product ${productId}. Debug info:`, debugResult.recordset);
            console.warn(`⚠️ This may indicate the product was already cancelled or doesn't exist for this member.`);
          }
        }
      }

      // 2. Handle configuration changes for existing products
      // For configuration changes, we terminate existing enrollments and create new ones
      // Compare current config values with initial (enrolled) config values to detect changes
      // IMPORTANT: Check against BOTH current AND future enrolled products
      const allEnrolledProductIds = new Set([...enrolledProductIds, ...futureEnrolledProductIds]);
      
      const configChanges = [];
      
      for (const [configKey, newValue] of Object.entries(configValues)) {
        const oldValue = initialConfigValues[configKey];
        
        // Skip if no change
        if (newValue === oldValue) continue;
        
        // Skip if config key is for a removed product
        if (removedProducts.includes(configKey)) continue;
        
        // Check if this is a bundle sub-product config key (format: {bundleId}-{subProductId})
        const isBundleConfig = configKey.includes('-') && configKey.split('-').length > 2;
        
        if (isBundleConfig) {
          // Extract bundle ID from key like "EB405DCF-E34C-4FE1-9634-BF00C9990801-267F6D0F-27CE-4BC1-A52C-9728EC775EF7"
          // Format: 8 chars + dash + 4 + dash + 4 + dash + 4 + dash + 12 = 36 chars for GUID
          const bundleId = configKey.substring(0, 36);
          
          // Check if this bundle is enrolled (current OR future)
          if (allEnrolledProductIds.has(bundleId) && !removedProducts.includes(bundleId)) {
            console.log(`🔍 Bundle sub-product config change detected:`, {
              bundleId: bundleId.substring(0, 8),
              configKey,
              oldValue,
              newValue,
              isCurrentEnrollment: enrolledProductIds.has(bundleId),
              isFutureEnrollment: futureEnrolledProductIds.has(bundleId)
            });
            
            // Add the BUNDLE for recreation (not the config key itself)
            if (!configChanges.some(([pid]) => pid === bundleId)) {
              configChanges.push([bundleId, newValue]);
            }
          }
        } else {
          // Regular product config change
          if (allEnrolledProductIds.has(configKey) && !removedProducts.includes(configKey)) {
            console.log(`🔍 Product config change detected:`, {
              productId: configKey.substring(0, 8),
              oldValue,
              newValue,
              isCurrentEnrollment: enrolledProductIds.has(configKey),
              isFutureEnrollment: futureEnrolledProductIds.has(configKey)
            });
            configChanges.push([configKey, newValue]);
          }
        }
      }

      console.log(`🔍 Configuration changes to process (terminate and recreate):`, 
        configChanges.map(([pid, val]) => ({ productId: pid.substring(0, 8), value: val })));

      for (const [productId, configValue] of configChanges) {
        // Check if this is a bundle product
        const isBundleProduct = bundleEnrollments.has(productId);
        
        if (isBundleProduct) {
          // Handle bundle configuration changes: terminate all component enrollments
          console.log(`🔍 Terminating bundle ${productId.substring(0, 8)} for configuration change:`, configValue);
          
          // DEBUG: Check what's available
          console.log(`🔍 DEBUG: Termination context:`, {
            productId: productId.substring(0, 8),
            currentEnrollmentsCount: currentEnrollments.length,
            futureEnrollmentsAvailable: typeof futureEnrollments !== 'undefined',
            futureEnrollmentsCount: futureEnrollments?.length || 0,
            futureEnrollmentsSample: futureEnrollments?.slice(0, 1).map(e => ({
              enrollmentId: e.EnrollmentId?.substring(0, 8),
              productBundleId: e.ProductBundleID?.substring(0, 8),
              productId: e.ProductId?.substring(0, 8)
            }))
          });
          
          // Look in BOTH current and future enrollments
          const bundleComponentEnrollments = [
            ...currentEnrollments.filter(e => e.ProductBundleID === productId),
            ...futureEnrollments.filter(e => e.ProductBundleID === productId)
          ];
          
          console.log(`📋 Found ${bundleComponentEnrollments.length} bundle component enrollments to terminate (current: ${currentEnrollments.filter(e => e.ProductBundleID === productId).length}, future: ${futureEnrollments.filter(e => e.ProductBundleID === productId).length})`);
          
          for (const enrollment of bundleComponentEnrollments) {
            const terminateRequest = transaction.request();
            terminateRequest.input('enrollmentId', sql.UniqueIdentifier, enrollment.EnrollmentId);
            terminateRequest.input('terminationDate', sql.Date, terminationDateForChanges);
            terminateRequest.input('modifiedDate', sql.DateTime2, new Date());
            terminateRequest.input('modifiedBy', sql.UniqueIdentifier, member.UserId);

            await terminateRequest.query(`
              UPDATE oe.Enrollments 
              SET Status = 'Inactive',
                  TerminationDate = @terminationDate,
                  ModifiedDate = @modifiedDate,
                  ModifiedBy = @modifiedBy
              WHERE EnrollmentId = @enrollmentId
            `);

            console.log(`✅ Terminated bundle component ${enrollment.ProductName} (terminates: ${terminationDateForChanges.toISOString().split('T')[0]})`);
          }
        } else {
          // Handle individual product configuration changes: terminate existing enrollment
          // Look in BOTH current and future enrollments
          const enrollment = currentEnrollments.find(e => e.ProductId === productId) ||
                           futureEnrollments.find(e => e.ProductId === productId);
          
          if (enrollment) {
            console.log(`🔍 Terminating product ${productId} (${enrollment.ProductName}) for configuration change`);
            
            const terminateRequest = transaction.request();
            terminateRequest.input('enrollmentId', sql.UniqueIdentifier, enrollment.EnrollmentId);
            terminateRequest.input('terminationDate', sql.Date, terminationDateForChanges);
            terminateRequest.input('modifiedDate', sql.DateTime2, new Date());
            terminateRequest.input('modifiedBy', sql.UniqueIdentifier, member.UserId);

            await terminateRequest.query(`
              UPDATE oe.Enrollments 
              SET Status = 'Inactive',
                  TerminationDate = @terminationDate,
                  ModifiedDate = @modifiedDate,
                  ModifiedBy = @modifiedBy
              WHERE EnrollmentId = @enrollmentId
            `);

            console.log(`✅ Terminated ${enrollment.ProductName} (terminates: ${terminationDateForChanges.toISOString().split('T')[0]})`);
          }
        }
      }

      // 3. Terminate all existing all-products contribution enrollments
      // These will be recreated with current rules by EnrollmentCompletionService
      let contributionsWereTerminated = false;
      if (member.GroupId) {
        console.log('🔍 Terminating existing all-products contribution enrollments...');
        
        const terminateAllProductsRequest = transaction.request();
        terminateAllProductsRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
        terminateAllProductsRequest.input('terminationDate', sql.Date, terminationDateForChanges);
        terminateAllProductsRequest.input('modifiedBy', sql.UniqueIdentifier, member.UserId);
        
        const terminateAllProductsResult = await terminateAllProductsRequest.query(`
          UPDATE oe.Enrollments
          SET Status = 'Inactive',
              TerminationDate = @terminationDate,
              ModifiedDate = GETUTCDATE(),
              ModifiedBy = @modifiedBy
          WHERE MemberId = @memberId
            AND EnrollmentType = 'Contribution'
            AND Status = 'Active'
        `);
        
        contributionsWereTerminated = terminateAllProductsResult.rowsAffected[0] > 0;
        console.log(`✅ Terminated ${terminateAllProductsResult.rowsAffected[0]} all-products contribution enrollments`);
      }

      // 4. Handle new product enrollments and configuration changes
      // ONLY enroll products that are:
      // - NEW (not currently enrolled), OR
      // - Have configuration changes (already handled above in configChanges)
      // ⚠️ CRITICAL: Filter out contribution enrollments - they're created automatically by EnrollmentCompletionService
      // We identify them by checking if they would result in EnrollmentType = 'Contribution'
      // The all-products GUID (00000000-0000-0000-0000-000000000000) is used for contribution enrollments
      const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';
      const productsToEnroll = selectedProducts.filter(productId => {
        // Never enroll the all-products GUID - it's not a real product, it's for contribution enrollments
        // Contribution enrollments are created automatically by EnrollmentCompletionService with EnrollmentType = 'Contribution'
        if (productId === ALL_PRODUCTS_GUID) {
          console.log(`⚠️ Skipping contribution enrollment placeholder (GUID) from product enrollment list: ${productId}`);
          return false;
        }
        
        const isRemoved = removedProducts.includes(productId);
        const isAlreadyEnrolled = currentlyEnrolledProductIds.has(productId);
        const hasConfigChange = configChanges.some(([pid]) => pid === productId);
        
        // Don't enroll if:
        // - Product is being removed
        // - Product is already enrolled AND has no config changes (keep as-is)
        if (isRemoved) return false;
        if (isAlreadyEnrolled && !hasConfigChange) return false;
        
        // Enroll if:
        // - Product is NEW (not enrolled)
        // - Product has config changes (will be recreated)
        return true;
      });
      
      console.log('🔍 Products to enroll breakdown:', {
        selectedProducts,
        currentlyEnrolledProductIds: Array.from(currentlyEnrolledProductIds),
        configChanges: configChanges.map(([pid]) => pid),
        productsToEnroll,
        reasoning: productsToEnroll.map(pid => ({
          productId: pid.substring(0, 8),
          isNew: !currentlyEnrolledProductIds.has(pid),
          hasConfigChange: configChanges.some(([p]) => p === pid)
        }))
      });
      
      // 4a. BEFORE enrolling: Check if any products being enrolled are bundles
      // If so, terminate any existing individual enrollments of the bundle's component products
      for (const productId of productsToEnroll) {
        console.log(`🔍 Checking if ${productId} is a bundle...`);
        
        // Check if this product is a bundle by looking in ProductBundles table
        const bundleComponentsQuery = `
          SELECT IncludedProductId as ProductId
          FROM oe.ProductBundles 
          WHERE BundleProductId = @productId
        `;
        
        const bundleComponentsRequest = transaction.request();
        bundleComponentsRequest.input('productId', sql.UniqueIdentifier, productId);
        const bundleComponentsResult = await bundleComponentsRequest.query(bundleComponentsQuery);
        
        if (bundleComponentsResult.recordset.length > 0) {
          const componentProductIds = bundleComponentsResult.recordset.map(r => r.ProductId);
          console.log(`✅ Product ${productId} is a bundle with ${componentProductIds.length} components:`, componentProductIds.map(id => id.substring(0, 8)));
          
          // Terminate any existing INDIVIDUAL enrollments of these component products
          for (const componentProductId of componentProductIds) {
            const terminateIndividualQuery = `
              UPDATE oe.Enrollments
              SET Status = 'Inactive',
                  TerminationDate = @terminationDate,
                  ModifiedDate = @modifiedDate,
                  ModifiedBy = @modifiedBy
              WHERE MemberId = @memberId
                AND ProductId = @componentProductId
                AND ProductBundleID IS NULL
                AND Status = 'Active'
            `;
            
            const terminateIndividualRequest = transaction.request();
            terminateIndividualRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
            terminateIndividualRequest.input('componentProductId', sql.UniqueIdentifier, componentProductId);
            terminateIndividualRequest.input('terminationDate', sql.Date, terminationDateForChanges);
            terminateIndividualRequest.input('modifiedDate', sql.DateTime2, new Date());
            terminateIndividualRequest.input('modifiedBy', sql.UniqueIdentifier, member.UserId);
            
            const result = await terminateIndividualRequest.query(terminateIndividualQuery);
            
            if (result.rowsAffected[0] > 0) {
              console.log(`✅ Terminated ${result.rowsAffected[0]} individual enrollment(s) of component product ${componentProductId.substring(0, 8)} (will be replaced by bundle)`);
            }
          }
        }
      }
      
      // CRITICAL: We need to recreate contribution enrollments even when no products are being enrolled
      // if we terminated contribution enrollments and the member is in a group with active products
      const needsContributionRecreation = contributionsWereTerminated && selectedProducts.length > 0;
      
      if (productsToEnroll.length > 0 || needsContributionRecreation) {
        // When recreating contributions only, use selectedProducts (active products) for contribution calculation
        const productsForEnrollment = productsToEnroll.length > 0 ? productsToEnroll : selectedProducts;
        
        // For contribution recreation, we need pricing for all selectedProducts
        // frontendPricing should already contain this, but if not, fetch from current enrollments
        let pricingForContributions = frontendPricing || [];
        
        if (needsContributionRecreation && (!pricingForContributions || pricingForContributions.length === 0)) {
          // Fetch current enrollment premiums from database
          console.log('🔍 Fetching current enrollment premiums for contribution calculation...');
          const currentEnrollmentsRequest = transaction.request();
          currentEnrollmentsRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
          
          // Set input parameters first
          selectedProducts.forEach((pid, i) => {
            currentEnrollmentsRequest.input(`product${i}`, sql.UniqueIdentifier, pid);
          });
          
          // Then execute query
          const currentEnrollmentsResult = await currentEnrollmentsRequest.query(`
            SELECT e.ProductId, e.PremiumAmount, p.Name as ProductName
            FROM oe.Enrollments e
            LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
            WHERE e.MemberId = @memberId
              AND e.Status = 'Active'
              AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
              AND e.ProductId != '00000000-0000-0000-0000-000000000000'
              AND e.ProductId IN (${selectedProducts.map((_, i) => `@product${i}`).join(',')})
          `);
          
          pricingForContributions = currentEnrollmentsResult.recordset.map(row => ({
            productId: row.ProductId,
            monthlyPremium: Number(row.PremiumAmount || 0),
            productName: row.ProductName || 'Unknown Product'
          }));
          console.log(`✅ Fetched ${pricingForContributions.length} current enrollment premiums for contribution calculation`);
        }
        
        if (productsToEnroll.length > 0) {
          console.log(`🔍 Processing ${productsToEnroll.length} product enrollments (new + config changes):`, productsToEnroll);
        } else {
          console.log(`🔍 Recreating contribution enrollments for ${selectedProducts.length} active products (no product changes needed)`);
        }

        // Use next effective date for all product changes (not the passed effectiveDate)
        const effectiveDateToUse = nextEffectiveDate.toISOString().split('T')[0];
        
        console.log(`📅 Using effective date: ${effectiveDateToUse} for new/changed enrollments`);

        // 🎯 CALCULATE CHARGE BEFORE CREATING ENROLLMENTS
        // This ensures PlanChangeCalculator doesn't see the newly created enrollments as "existing"
        if (productsToEnroll.length > 0) {
          console.log('🎯 Calling PlanChangeCalculator BEFORE enrollment creation...');
          
          const preEnrollmentCalculation = await PlanChangeCalculator.calculatePlanChangeCost({
            memberId: member.MemberId,
            householdId: member.HouseholdId,
            selectedProducts: productsToEnroll,
            removedProducts,
            frontendPricing,
            configValues,
            initialConfigValues,
            dependentsToAdd,
            newTobaccoUse,
            calculatedTier,
            isGroupMember,
            transaction // Pass transaction to use existing connection
          });
          
          console.log('✅ Pre-enrollment calculation results:', {
            dueToday: preEnrollmentCalculation.dueToday,
            newMonthlyTotal: preEnrollmentCalculation.newMonthlyTotal,
            explanation: preEnrollmentCalculation.explanation
          });
        }

        const enrollmentResult = await EnrollmentCompletionService.completeEnrollment({
          memberId: member.MemberId,
          selectedProducts: productsForEnrollment, // Use productsForEnrollment (may be selectedProducts if recreating contributions only)
          selectedConfigs: configValues,
          frontendPricing: pricingForContributions, // Use pricingForContributions to ensure contributions can be calculated
          householdMembers,
          effectiveDate: effectiveDateToUse, // Use calculated next effective date
          acknowledgements,
          digitalSignature,
          memberInfo,
          ipAddress,
          userAgent,
          transaction,
          member,
          // Pass tier/tobacco overrides for pricing validation
          // CRITICAL: Use finalCalculatedTier (from household) instead of frontend's calculatedTier
          calculatedTier: finalCalculatedTier,
          newTobaccoUse
        });

        if (!enrollmentResult.success) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            message: enrollmentResult.error || 'Failed to complete enrollment'
          });
        }

        console.log('✅ Enrollment completion result:', enrollmentResult.data);
        
        // Track if we created any enrollments (for post-commit activation)
        hasEnrollments = (enrollmentResult?.data?.createdEnrollments?.length > 0) || 
                        (enrollmentResult?.data?.updatedEnrollments?.length > 0);

        // 4b. Handle fee enrollments (SystemFee and PaymentProcessingFee) - same as enrollment wizard
        // Only for group members - individual members handle fees through DIME payment processing
        if (member.GroupId && hasEnrollments) {
          try {
            console.log('💰 Processing fee enrollments for group member...');
            
            // Calculate base premiums from ALL active product enrollments in the HOUSEHOLD (same intent as enrollment wizard)
            // Note: Product PremiumAmount is the base premium; fee portions are handled separately.
            const totalPremiumQuery = `
              SELECT e.ProductId, SUM(e.PremiumAmount) as ProductPremium
              FROM oe.Enrollments e
              INNER JOIN oe.Members m ON e.MemberId = m.MemberId
              WHERE m.HouseholdId = @householdId
                AND (e.Status = 'Active' OR e.Status = 'Pending')
                AND (e.TerminationDate IS NULL OR e.TerminationDate > GETDATE())
                AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                AND e.ProductId != '00000000-0000-0000-0000-000000000000'
              GROUP BY e.ProductId
            `;
            const totalPremiumRequest = transaction.request();
            totalPremiumRequest.input('householdId', sql.UniqueIdentifier, member.HouseholdId);
            const totalPremiumResult = await totalPremiumRequest.query(totalPremiumQuery);
            const basePremiumByProductId = new Map();
            let totalPremium = 0;
            for (const row of (totalPremiumResult.recordset || [])) {
              const pid = row.ProductId ? String(row.ProductId) : null;
              const amt = Number(row.ProductPremium || 0) || 0;
              if (!pid) continue;
              basePremiumByProductId.set(pid, amt);
              totalPremium += amt;
            }
            totalPremium = Math.round(totalPremium * 100) / 100;
            
            console.log(`💰 Group enrollment - Total household premium (before contributions): $${totalPremium.toFixed(2)}`);
            
            // ALWAYS terminate old fee enrollments first (even if totalPremium is 0 - i.e., all products cancelled)
            // This ensures fees are properly cleaned up when all products are cancelled
            // Fees are stored on the primary member, so get primary member first
            let primaryMember = null;
            const primaryMemberQuery = `
              SELECT TOP 1 m.MemberId, m.HouseholdId, m.AgentId, m.UserId
              FROM oe.Members m
              WHERE m.HouseholdId = @householdId
                AND m.RelationshipType = 'P'
            `;
            const primaryMemberRequest = transaction.request();
            primaryMemberRequest.input('householdId', sql.UniqueIdentifier, member.HouseholdId);
            const primaryMemberResult = await primaryMemberRequest.query(primaryMemberQuery);
            primaryMember = primaryMemberResult.recordset[0];
            
            if (primaryMember) {
              console.log('🔄 Terminating old fee enrollments on primary member...');
              const terminateFeesRequest = transaction.request();
              terminateFeesRequest.input('memberId', sql.UniqueIdentifier, primaryMember.MemberId);
              terminateFeesRequest.input('terminationDate', sql.Date, effectiveDateToUse);
              terminateFeesRequest.input('modifiedBy', sql.UniqueIdentifier, member.UserId);
              
              await terminateFeesRequest.query(`
                UPDATE oe.Enrollments
                SET Status = 'Inactive',
                    TerminationDate = @terminationDate,
                    ModifiedDate = GETUTCDATE(),
                    ModifiedBy = @modifiedBy
                WHERE MemberId = @memberId
                  AND (EnrollmentType = 'SystemFee' OR EnrollmentType = 'PaymentProcessingFee')
                  AND (Status = 'Active' OR Status = 'Pending')
                  AND (TerminationDate IS NULL OR TerminationDate > GETDATE())
              `);
              
              console.log('✅ Terminated old fee enrollments');
            } else {
              console.log('⚠️ No primary member found for household, skipping fee termination');
            }
            
            // Only create new fee enrollments if there are active products (totalPremium > 0)
            if (totalPremium > 0) {
              // Fetch tenant's payment processor settings and system fees
              const tenantSettingsQuery = `
                SELECT PaymentProcessorSettings, SystemFees
                FROM oe.Tenants 
                WHERE TenantId = @tenantId
              `;
              
              const tenantSettingsRequest = transaction.request();
              tenantSettingsRequest.input('tenantId', sql.UniqueIdentifier, member.TenantId);
              const tenantSettingsResult = await tenantSettingsRequest.query(tenantSettingsQuery);
              
              let paymentProcessorSettings = null;
              let systemFeesSettings = null;
              
              if (tenantSettingsResult.recordset.length > 0) {
                if (tenantSettingsResult.recordset[0].PaymentProcessorSettings) {
                  try {
                    paymentProcessorSettings = JSON.parse(tenantSettingsResult.recordset[0].PaymentProcessorSettings);
                  } catch (e) {
                    console.warn('⚠️ Failed to parse PaymentProcessorSettings:', e);
                  }
                }
                
                if (tenantSettingsResult.recordset[0].SystemFees) {
                  try {
                    systemFeesSettings = JSON.parse(tenantSettingsResult.recordset[0].SystemFees);
                  } catch (e) {
                    console.warn('⚠️ Failed to parse SystemFees:', e);
                  }
                }
              }
              
              // Get group's primary payment method for fee calculation (same logic as enrollment-links.js)
              let groupPaymentMethod = 'ACH'; // Default fallback to ACH
              let paymentMethodSource = 'default'; // Track where the payment method came from
              
              if (member.GroupId) {
                console.log(`🔍 Looking up payment method for group: ${member.GroupId}`);
                const groupPaymentMethodQuery = `
                  SELECT TOP 1 Type, IsDefault, PaymentMethodId, CreatedDate
                  FROM oe.GroupPaymentMethods
                  WHERE GroupId = @groupId
                    AND Status = 'Active'
                  ORDER BY IsDefault DESC, CreatedDate DESC
                `;
                const groupPaymentMethodRequest = transaction.request();
                groupPaymentMethodRequest.input('groupId', sql.UniqueIdentifier, member.GroupId);
                const groupPaymentMethodResult = await groupPaymentMethodRequest.query(groupPaymentMethodQuery);
                
                if (groupPaymentMethodResult.recordset.length > 0) {
                  const paymentMethodRecord = groupPaymentMethodResult.recordset[0];
                  groupPaymentMethod = paymentMethodRecord.Type || 'ACH';
                  paymentMethodSource = paymentMethodRecord.IsDefault ? 'default_payment_method' : 'most_recent_active';
                  console.log(`✅ Group payment method found: ${groupPaymentMethod} (Source: ${paymentMethodSource}, PaymentMethodId: ${paymentMethodRecord.PaymentMethodId}, IsDefault: ${paymentMethodRecord.IsDefault})`);
                } else {
                  paymentMethodSource = 'fallback_no_payment_methods';
                  console.log(`⚠️ No active payment method found for group ${member.GroupId}`);
                  console.log(`💡 Using fallback payment method: ACH (default for group enrollments when no payment method is configured)`);
                }
              } else {
                paymentMethodSource = 'fallback_no_group_id';
                console.log(`⚠️ No GroupId in member, using fallback payment method: ACH`);
              }
              
              console.log(`💳 Payment method determined for processing fee calculation: ${groupPaymentMethod} (Source: ${paymentMethodSource})`);
              
              // Calculate system fees and payment processing fees separately.
              // NOTE: Product PremiumAmount is base premium; included fee portions are persisted per product and then deducted from the Fees line for UI display.
              const productProcessingFeesUtil = require('../../../utils/productProcessingFees');
              
              // Load per-product subscription fee settings (TenantProductSubscriptions)
              const subscriptionFeeSettingsByProductId = new Map();
              if (basePremiumByProductId.size > 0) {
                const loadedSettings = await productProcessingFeesUtil.loadSubscriptionFeeSettingsByProductId({
                  poolOrTransaction: transaction,
                  tenantId: member.TenantId,
                  productIds: Array.from(basePremiumByProductId.keys())
                });
                loadedSettings.forEach((v, k) => subscriptionFeeSettingsByProductId.set(k, v));
              }

              // Phase 5.4 — single-source fee composition via pricingAuthority.
              // Per-product persistence below still reads `feeBreakdown.includedProcessingFeeByProductId`,
              // which the authority exposes under `_raw.feeBreakdown`.
              const pricingAuthority = require('../../../services/pricing/pricingAuthority.service');
              const pricingProducts = Array.from(basePremiumByProductId.entries())
                .map(([productId, monthlyPremium]) => ({ productId, monthlyPremium: Number(monthlyPremium || 0) }));
              const authorityOutput = await pricingAuthority.computePricing({
                poolOrTransaction: transaction,
                tenantId: member.TenantId,
                pricingProducts,
                paymentMethodType: groupPaymentMethod
              });
              const feeBreakdown = authorityOutput._raw.feeBreakdown;
              const chargeFeeToMemberEnabled = authorityOutput._raw.chargeFeeToMemberEnabled;
              const includedProcessingFeeTotal = authorityOutput.totals.includedFeeTotal;
              const nonIncludedPremiumSubtotal = feeBreakdown.nonIncludedPremiumSubtotal;

              // Persist included processing fee allocations for display on product enrollments (primary member only)
              if (primaryMember?.MemberId) {
                // Reset to 0 for active product enrollments on primary member before applying latest values
                const resetIncludedRequest = transaction.request();
                resetIncludedRequest.input('memberId', sql.UniqueIdentifier, primaryMember.MemberId);
                /** @deprecated Legacy display column — see includedFeeDeprecation.js */
                await resetIncludedRequest.query(`
                  UPDATE oe.Enrollments
                  SET IncludedPaymentProcessingFeeAmount = 0,
                      ModifiedDate = GETUTCDATE()
                  WHERE MemberId = @memberId
                    AND (Status = 'Active' OR Status = 'Pending')
                    AND (TerminationDate IS NULL OR TerminationDate > GETDATE())
                    AND (EnrollmentType = 'Product' OR EnrollmentType IS NULL)
                    AND ProductId != '00000000-0000-0000-0000-000000000000'
                `);
                
                if (includedProcessingFeeTotal > 0) {
                  for (const [productId, productPremium] of basePremiumByProductId.entries()) {
                    const cfg = subscriptionFeeSettingsByProductId.get(String(productId));
                    const includeProcessingFee = chargeFeeToMemberEnabled && cfg?.includeProcessingFee === true;
                    if (!includeProcessingFee) continue;
                    
                    const includedFeeForProduct = Number(
                      feeBreakdown.includedProcessingFeeByProductId[String(productId)] || 0
                    );
                    if (includedFeeForProduct <= 0) continue;
                    
                    const enrollmentIdRequest = transaction.request();
                    enrollmentIdRequest.input('memberId', sql.UniqueIdentifier, primaryMember.MemberId);
                    enrollmentIdRequest.input('productId', sql.UniqueIdentifier, productId);
                    const enrollmentIdResult = await enrollmentIdRequest.query(`
                      SELECT TOP 1 EnrollmentId
                      FROM oe.Enrollments
                      WHERE MemberId = @memberId
                        AND ProductId = @productId
                        AND (Status = 'Active' OR Status = 'Pending')
                        AND (TerminationDate IS NULL OR TerminationDate > GETDATE())
                        AND (EnrollmentType = 'Product' OR EnrollmentType IS NULL)
                      ORDER BY CreatedDate DESC
                    `);
                    
                    const enrollmentId = enrollmentIdResult.recordset?.[0]?.EnrollmentId;
                    if (!enrollmentId) continue;
                    
                    const updateIncludedRequest = transaction.request();
                    updateIncludedRequest.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
                    updateIncludedRequest.input('amt', sql.Decimal(19, 4), includedFeeForProduct);
                    /** @deprecated Legacy display column — see includedFeeDeprecation.js */
                    await updateIncludedRequest.query(`
                      UPDATE oe.Enrollments
                      SET IncludedPaymentProcessingFeeAmount = @amt,
                          ModifiedDate = GETUTCDATE()
                      WHERE EnrollmentId = @enrollmentId
                    `);
                  }
                }
              }

              // System fee: keep consistent with enrollment-links flow (custom system fee override/skip logic)
              const systemFeesAmount = productProcessingFeesUtil.calculateSystemFeeAmount({
                subscriptionFeeSettingsByProductId,
                basePremiumTotal: totalPremium,
                systemFeesSettings
              });

              // Calculate payment processing fee on the NON-included subtotal (remainder shown on Fees line)
              // ⚠️ SECURITY: Processing fees are ALWAYS calculated server-side - never accept from frontend
              const nonIncludedPaymentProcessingFeeAmount = feeBreakdown.nonIncludedProcessingFeeAmount;

              // PPF enrollment row stores non-included remainder only; included fee lives on product rows.
              const paymentProcessingFeeRemainderForRow = Math.round(Number(nonIncludedPaymentProcessingFeeAmount || 0) * 100) / 100;
              const paymentProcessingFeeTotal = Math.round((paymentProcessingFeeRemainderForRow + Number(includedProcessingFeeTotal || 0)) * 100) / 100;
              
              console.log(`💳 Group enrollment - Fees calculated:`, {
                paymentMethod: groupPaymentMethod,
                paymentMethodSource: paymentMethodSource,
                totalPremium: `$${totalPremium.toFixed(2)}`,
                systemFees: `$${systemFeesAmount.toFixed(2)}`,
                paymentProcessingFeeTotal: `$${paymentProcessingFeeTotal.toFixed(2)}`,
                paymentProcessingFeeRemainder: `$${paymentProcessingFeeRemainderForRow.toFixed(2)}`,
                chargeFeeToMember: paymentProcessorSettings?.chargeFeeToMember || false
              });
              
              if (paymentMethodSource.includes('fallback')) {
                console.log(`📝 NOTE: Processing fee calculated using fallback payment method (${groupPaymentMethod}) because: ${paymentMethodSource}`);
              }
              
              // Create new fee enrollment records (SystemFee and PaymentProcessingFee)
              // Primary member was already fetched above for fee termination, should be available here
              
              if (primaryMember && (systemFeesAmount > 0 || paymentProcessingFeeRemainderForRow > 0)) {
                const NON_PRODUCT_PRODUCT_ID = '00000000-0000-0000-0000-000000000000';
                const crypto = require('crypto');
                
                // Create SystemFee enrollment record if amount > 0
                if (systemFeesAmount > 0) {
                  const systemFeeEnrollmentId = crypto.randomUUID();
                  const enrollmentAgentId = primaryMember.AgentId || member.AgentId || null;
                  const enrollmentEffectiveDate = effectiveDateToUse ? new Date(effectiveDateToUse) : new Date();
                  
                  const systemFeeRequest = transaction.request();
                  systemFeeRequest.input('enrollmentId', sql.UniqueIdentifier, systemFeeEnrollmentId);
                  systemFeeRequest.input('memberId', sql.UniqueIdentifier, primaryMember.MemberId);
                  systemFeeRequest.input('productId', sql.UniqueIdentifier, NON_PRODUCT_PRODUCT_ID);
                  systemFeeRequest.input('agentId', sql.UniqueIdentifier, enrollmentAgentId);
                  systemFeeRequest.input('effectiveDate', sql.Date, enrollmentEffectiveDate);
                  systemFeeRequest.input('premiumAmount', sql.Decimal(19,4), systemFeesAmount);
                  systemFeeRequest.input('paymentFrequency', sql.NVarChar, 'Monthly');
                  systemFeeRequest.input('status', sql.NVarChar, 'Active');
                  systemFeeRequest.input('householdId', sql.UniqueIdentifier, primaryMember.HouseholdId);
                  systemFeeRequest.input('enrollmentType', sql.NVarChar, 'SystemFee');
                  systemFeeRequest.input('createdBy', sql.UniqueIdentifier, primaryMember.UserId);
                  systemFeeRequest.input('modifiedBy', sql.UniqueIdentifier, primaryMember.UserId);
                  systemFeeRequest.input('groupId', sql.UniqueIdentifier, member.GroupId);
                  
                  await systemFeeRequest.query(`
                    INSERT INTO oe.Enrollments (
                      EnrollmentId, MemberId, ProductId, AgentId, Status, EffectiveDate,
                      PremiumAmount, PaymentFrequency, GroupId, HouseholdId, EnrollmentType,
                      CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
                    )
                    VALUES (
                      @enrollmentId, @memberId, @productId, @agentId, 'Active', @effectiveDate,
                      @premiumAmount, @paymentFrequency, @groupId, @householdId, @enrollmentType,
                      GETUTCDATE(), GETUTCDATE(), @createdBy, @modifiedBy
                    )
                  `);
                  
                  console.log(`✅ Created SystemFee enrollment: ${systemFeeEnrollmentId} with amount $${systemFeesAmount.toFixed(2)}`);
                }
                
                // Create PaymentProcessingFee enrollment record if non-included remainder > 0
                if (paymentProcessingFeeRemainderForRow > 0) {
                  const processingFeeEnrollmentId = crypto.randomUUID();
                  const enrollmentAgentId = primaryMember.AgentId || member.AgentId || null;
                  const enrollmentEffectiveDate = effectiveDateToUse ? new Date(effectiveDateToUse) : new Date();
                  
                  const processingFeeRequest = transaction.request();
                  processingFeeRequest.input('enrollmentId', sql.UniqueIdentifier, processingFeeEnrollmentId);
                  processingFeeRequest.input('memberId', sql.UniqueIdentifier, primaryMember.MemberId);
                  processingFeeRequest.input('productId', sql.UniqueIdentifier, NON_PRODUCT_PRODUCT_ID);
                  processingFeeRequest.input('agentId', sql.UniqueIdentifier, enrollmentAgentId);
                  processingFeeRequest.input('effectiveDate', sql.Date, enrollmentEffectiveDate);
                  processingFeeRequest.input('premiumAmount', sql.Decimal(19,4), paymentProcessingFeeRemainderForRow);
                  processingFeeRequest.input('paymentFrequency', sql.NVarChar, 'Monthly');
                  processingFeeRequest.input('status', sql.NVarChar, 'Active');
                  processingFeeRequest.input('householdId', sql.UniqueIdentifier, primaryMember.HouseholdId);
                  processingFeeRequest.input('enrollmentType', sql.NVarChar, 'PaymentProcessingFee');
                  processingFeeRequest.input('createdBy', sql.UniqueIdentifier, primaryMember.UserId);
                  processingFeeRequest.input('modifiedBy', sql.UniqueIdentifier, primaryMember.UserId);
                  processingFeeRequest.input('groupId', sql.UniqueIdentifier, member.GroupId);
                  
                  await processingFeeRequest.query(`
                    INSERT INTO oe.Enrollments (
                      EnrollmentId, MemberId, ProductId, AgentId, Status, EffectiveDate,
                      PremiumAmount, PaymentFrequency, GroupId, HouseholdId, EnrollmentType,
                      CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
                    )
                    VALUES (
                      @enrollmentId, @memberId, @productId, @agentId, 'Active', @effectiveDate,
                      @premiumAmount, @paymentFrequency, @groupId, @householdId, @enrollmentType,
                      GETUTCDATE(), GETUTCDATE(), @createdBy, @modifiedBy
                    )
                  `);
                  
                  console.log(`✅ Created PaymentProcessingFee enrollment: ${processingFeeEnrollmentId} with amount $${paymentProcessingFeeRemainderForRow.toFixed(2)}`);
                }
              }
            }
          } catch (error) {
            // Log error but don't fail enrollment - fee calculation is important but shouldn't block enrollment
            console.error('⚠️ Error calculating/creating fee enrollments for group enrollment:', error);
          }
        }

        // 5. NEW: Handle credit enrollments for individual members modifying future enrollments
        // Per plan-changes-logic.md - Create credit enrollments for negative/positive differences
        if (!isGroupMember && hasFutureEnrollments && productsBeingModified.length > 0) {
          console.log('💰 Checking for credit enrollment creation (future enrollment modification)...');
          
          // Calculate old premium total from future enrollments that are being modified
          let oldPremiumTotal = 0;
          const modifiedProductIds = new Set(productsBeingModified);
          for (const enrollment of futureEnrollments) {
            const enrollmentProductId = enrollment.ProductBundleID || enrollment.ProductId;
            if (modifiedProductIds.has(enrollmentProductId)) {
              oldPremiumTotal += Number(enrollment.PremiumAmount) || 0;
            }
          }
          
          // Calculate new premium total from created enrollments
          let newPremiumTotal = 0;
          if (enrollmentResult?.data?.createdEnrollments) {
            for (const enrollment of enrollmentResult.data.createdEnrollments) {
              newPremiumTotal += Number(enrollment.premiumAmount) || 0;
            }
          }
          
          // Also include existing future enrollments that weren't modified (keep their premiums)
          for (const enrollment of futureEnrollments) {
            const enrollmentProductId = enrollment.ProductBundleID || enrollment.ProductId;
            if (!modifiedProductIds.has(enrollmentProductId)) {
              newPremiumTotal += Number(enrollment.PremiumAmount) || 0;
            }
          }
          
          const premiumDifference = newPremiumTotal - oldPremiumTotal;
          
          console.log('💰 Premium comparison:', {
            oldPremiumTotal,
            newPremiumTotal,
            premiumDifference,
            hasDifference: Math.abs(premiumDifference) > 0.01
          });
          
          // Create credit enrollment if there's a difference (positive or negative)
          if (Math.abs(premiumDifference) > 0.01) {
            const creditAmount = Math.abs(premiumDifference);
            const isNegativeDifference = premiumDifference < 0; // Member gets money back
            
            // Calculate next billing cycle start (first of next month after effective date).
            // UTC arithmetic: nextEffectiveDate is now a UTC-midnight Date (since the helper
            // switched to Date.UTC). Local setMonth/getMonth would shift days on non-UTC servers.
            const nextBillingCycleStart = new Date(Date.UTC(
              nextEffectiveDate.getUTCFullYear(),
              nextEffectiveDate.getUTCMonth() + 1,
              1
            ));
            const creditTerminationDate = new Date(Date.UTC(
              nextBillingCycleStart.getUTCFullYear(),
              nextBillingCycleStart.getUTCMonth(),
              nextBillingCycleStart.getUTCDate() + 1
            ));
            
            const creditEnrollmentId = require('crypto').randomUUID();
            const creditEnrollmentRequest = transaction.request();
            
            creditEnrollmentRequest.input('enrollmentId', sql.UniqueIdentifier, creditEnrollmentId);
            creditEnrollmentRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
            creditEnrollmentRequest.input('productId', sql.UniqueIdentifier, '00000000-0000-0000-0000-000000000000'); // System product ID for credits
            creditEnrollmentRequest.input('agentId', sql.UniqueIdentifier, member.AgentId || null);
            creditEnrollmentRequest.input('status', sql.NVarChar(50), 'Active');
            creditEnrollmentRequest.input('effectiveDate', sql.Date, nextBillingCycleStart);
            creditEnrollmentRequest.input('terminationDate', sql.Date, creditTerminationDate);
            creditEnrollmentRequest.input('premiumAmount', sql.Decimal(10, 2), isNegativeDifference ? -creditAmount : creditAmount);
            creditEnrollmentRequest.input('paymentFrequency', sql.NVarChar(50), 'Monthly');
            creditEnrollmentRequest.input('enrollmentType', sql.NVarChar(50), 'Credit');
            creditEnrollmentRequest.input('enrollmentDetails', sql.NVarChar, JSON.stringify({
              type: 'credit',
              reason: 'future_enrollment_modification',
              oldPremium: oldPremiumTotal,
              newPremium: newPremiumTotal,
              difference: premiumDifference,
              direction: isNegativeDifference ? 'credit_to_member' : 'member_owes'
            }));
            creditEnrollmentRequest.input('householdId', sql.UniqueIdentifier, member.HouseholdId);
            creditEnrollmentRequest.input('createdBy', sql.UniqueIdentifier, member.UserId);
            creditEnrollmentRequest.input('modifiedBy', sql.UniqueIdentifier, member.UserId);
            
            await creditEnrollmentRequest.query(`
              INSERT INTO oe.Enrollments (
                EnrollmentId, MemberId, ProductId, AgentId, Status, EffectiveDate, TerminationDate,
                PremiumAmount, PaymentFrequency, EnrollmentType, EnrollmentDetails, HouseholdId,
                CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
              ) VALUES (
                @enrollmentId, @memberId, @productId, @agentId, @status, @effectiveDate, @terminationDate,
                @premiumAmount, @paymentFrequency, @enrollmentType, @enrollmentDetails, @householdId,
                GETUTCDATE(), GETUTCDATE(), @createdBy, @modifiedBy
              )
            `);
            
            console.log(`✅ Created credit enrollment: ${creditEnrollmentId}`, {
              amount: isNegativeDifference ? -creditAmount : creditAmount,
              effectiveDate: nextBillingCycleStart.toISOString().split('T')[0],
              terminationDate: creditTerminationDate.toISOString().split('T')[0],
              type: isNegativeDifference ? 'credit_to_member' : 'member_owes'
            });
            
            // Store credit info for dual recurring payment setup
            paymentProcessingData = paymentProcessingData || {};
            paymentProcessingData.creditAmount = creditAmount;
            paymentProcessingData.isNegativeDifference = isNegativeDifference;
            paymentProcessingData.nextBillingCycleStart = nextBillingCycleStart;
            paymentProcessingData.newPremiumTotal = newPremiumTotal;
          } else {
            console.log('💰 No premium difference - skipping credit enrollment creation');
          }
        }

        // 6. Handle DIME payments (only for individual members, not group members)
        // ⚠️ CRITICAL: NEVER set up DIME payments for group members - they're handled at group level
        console.log('🔍 DEBUG: About to check isGroupMember:', { isGroupMember, hasGroupId: !!member.GroupId });
        if (!isGroupMember && !member.GroupId) {
          console.log('🔍 DEBUG: Processing individual member payment');
          // Get the first enrollment ID from the created enrollments for payment record
          const enrollmentId = enrollmentResult?.data?.createdEnrollments?.[0]?.enrollmentId || null;
          console.log('🔍 DEBUG: Enrollment ID for payment:', {
            enrollmentResult: !!enrollmentResult,
            hasData: !!enrollmentResult?.data,
            hasCreatedEnrollments: !!enrollmentResult?.data?.createdEnrollments,
            createdEnrollmentsLength: enrollmentResult?.data?.createdEnrollments?.length || 0,
            enrollmentId: enrollmentId,
            fullEnrollmentResult: enrollmentResult
          });
          
          // paymentMethodInfo is already declared at the top level
          // hasEnrollments is already defined above
          
          if (hasEnrollments) {
            // 🎯 USE PRE-ENROLLMENT CALCULATION - Calculated before creating enrollments
            // This ensures PlanChangeCalculator sees the state BEFORE new enrollments were added
            console.log('📊 Using pre-enrollment calculation results...');
            
            // Extract calculated values from pre-enrollment calculation
            const chargeAmount = preEnrollmentCalculation.dueToday;
            const calculatedMonthlyTotal = preEnrollmentCalculation.newMonthlyTotal;
            const isIncrementalCharge = chargeAmount > 0 && (preEnrollmentCalculation.paymentStatus?.hasFutureEnrollments || false);
            
            console.log('✅ Using pre-enrollment charge calculation:', {
              dueToday: chargeAmount,
              newMonthlyTotal: calculatedMonthlyTotal,
              isIncremental: isIncrementalCharge,
              explanation: preEnrollmentCalculation.explanation,
              breakdown: preEnrollmentCalculation.breakdown
            });
            
            // Store actual amounts in outer scope for response
            actualChargeAmount = chargeAmount;
            actualIsIncremental = isIncrementalCharge;
            
            // ✅ REFACTORED: Removed ~350 lines of duplicate calculation code
            // Now using PlanChangeCalculator.calculatePlanChangeCost() as single source of truth
            // Calculation happens BEFORE enrollment creation to avoid seeing newly created enrollments
            // VERIFY both charge amount AND monthly total match what user was shown
            // NOTE: Group members should always have $0 charge (employer pays)
            if (expectedChargeAmount !== null || expectedMonthlyTotal !== null) {
              const roundedExpectedCharge = expectedChargeAmount !== null ? Math.round(expectedChargeAmount * 100) / 100 : null;
              const roundedCalculatedCharge = Math.round(chargeAmount * 100) / 100;
              const roundedExpectedMonthly = expectedMonthlyTotal !== null ? Math.round(expectedMonthlyTotal * 100) / 100 : null;
              const roundedCalculatedMonthly = Math.round(calculatedMonthlyTotal * 100) / 100;
              
              console.log('🔍 Payment verification:', {
                isGroupMember: isGroupMember,
                chargeAmount: {
                  expected: roundedExpectedCharge,
                  calculated: roundedCalculatedCharge,
                  match: roundedExpectedCharge === null || roundedExpectedCharge === roundedCalculatedCharge
                },
                monthlyTotal: {
                  expected: roundedExpectedMonthly,
                  calculated: roundedCalculatedMonthly,
                  match: roundedExpectedMonthly === null || roundedExpectedMonthly === roundedCalculatedMonthly
                },
                chargeType: {
                  expected: expectedIsIncremental,
                  calculated: isIncrementalCharge
                }
              });
              
              // Check charge amount if provided
              if (roundedExpectedCharge !== null && roundedExpectedCharge !== roundedCalculatedCharge) {
                await transaction.rollback();
                console.error('❌ Charge amount mismatch!', {
                  shown_to_user: roundedExpectedCharge,
                  calculated: roundedCalculatedCharge,
                  difference: roundedCalculatedCharge - roundedExpectedCharge
                });
                return res.status(400).json({
                  success: false,
                  message: `Due today amount mismatch. Please refresh and try again. (Expected: $${roundedExpectedCharge}, Calculated: $${roundedCalculatedCharge})`,
                  error: {
                    code: 'CHARGE_AMOUNT_MISMATCH',
                    expectedAmount: roundedExpectedCharge,
                    calculatedAmount: roundedCalculatedCharge
                  }
                });
              }
              
              // Check monthly total if provided
              if (roundedExpectedMonthly !== null && roundedExpectedMonthly !== roundedCalculatedMonthly) {
                await transaction.rollback();
                console.error('❌ Monthly premium mismatch!', {
                  shown_to_user: roundedExpectedMonthly,
                  calculated: roundedCalculatedMonthly,
                  difference: roundedCalculatedMonthly - roundedExpectedMonthly
                });
                return res.status(400).json({
                  success: false,
                  message: `Monthly premium mismatch. Please refresh and try again. (Expected: $${roundedExpectedMonthly}/mo, Calculated: $${roundedCalculatedMonthly}/mo)`,
                  error: {
                    code: 'MONTHLY_TOTAL_MISMATCH',
                    expectedAmount: roundedExpectedMonthly,
                    calculatedAmount: roundedCalculatedMonthly
                  }
                });
              }
              
              console.log('✅ Payment amounts verified - match confirmation page');
            } else {
              console.log('⚠️ No expected amounts provided - skipping verification (legacy flow)');
            }
            
            // 🔒 ACID COMPLIANCE: Store payment info for post-commit processing
            // We'll process DIME payments AFTER database commit to maintain consistency
            // This prevents scenarios where payment succeeds but DB commit fails (or vice versa)
            const finalEnrollmentId = enrollmentId || enrollmentResult?.data?.updatedEnrollments?.[0]?.enrollmentId || null;
            console.log('🔍 Storing payment info for post-commit processing:', {
              enrollmentId: finalEnrollmentId,
              chargeAmount,
              calculatedMonthlyTotal,
              isIncremental: isIncrementalCharge
            });
            
            // Store payment processing data for after commit (use outer scope variable)
            // Merge with credit info if it was set earlier
            paymentProcessingData = {
              memberId: member.MemberId,
              householdId: member.HouseholdId,
              enrollmentId: finalEnrollmentId,
              paymentMethod: paymentMethod,
              nextEffectiveDate: nextEffectiveDate.toISOString().split('T')[0],
                chargeAmount, 
                isIncrementalCharge,
                calculatedMonthlyTotal,
              tenantId: member.TenantId,
              frontendPricing,
              // Merge credit info if it exists (from credit enrollment creation above)
              ...(paymentProcessingData?.creditAmount ? {
                creditAmount: paymentProcessingData.creditAmount,
                isNegativeDifference: paymentProcessingData.isNegativeDifference,
                nextBillingCycleStart: paymentProcessingData.nextBillingCycleStart,
                newPremiumTotal: paymentProcessingData.newPremiumTotal
              } : {})
            };
          } else {
            console.log('⚠️ No enrollments created or updated, skipping payment processing');
          }
        } else {
          console.log('🔍 DEBUG: Skipping payment processing for group member');
        }
      }

      // 5. Handle acknowledgements separately for product changes
      // This ensures acknowledgements are properly stored in oe.EnrollmentAcknowledgements
      if (acknowledgements && acknowledgements.length > 0 && digitalSignature) {
        console.log('📝 Processing acknowledgements for product changes...');
        
        // Generate a unique identifier for this product change session
        const changeSessionId = require('crypto').randomUUID();
        
        // Save acknowledgements to oe.EnrollmentAcknowledgements table
        for (const acknowledgement of acknowledgements) {
          const acknowledgementRequest = transaction.request();
          const acknowledgementId = require('crypto').randomUUID();
          
          acknowledgementRequest.input('acknowledgementId', sql.UniqueIdentifier, acknowledgementId);
          acknowledgementRequest.input('linkToken', sql.NVarChar, `product-change-${changeSessionId}`); // Use product change session ID as link token
          acknowledgementRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
          acknowledgementRequest.input('productId', sql.UniqueIdentifier, acknowledgement.productId);
          acknowledgementRequest.input('questionId', sql.NVarChar, acknowledgement.questionId);
          // Convert response to string - handle both boolean and string responses
          const responseString = typeof acknowledgement.response === 'boolean' 
            ? acknowledgement.response.toString() 
            : String(acknowledgement.response || '');
          acknowledgementRequest.input('response', sql.NVarChar, responseString);
          acknowledgementRequest.input('digitalSignature', sql.NVarChar, digitalSignature);
          acknowledgementRequest.input('signedDate', sql.DateTime2, new Date());
          acknowledgementRequest.input('createdDate', sql.DateTime2, new Date());
          // For product changes, we don't have a specific file upload ID, so we'll use null
          acknowledgementRequest.input('fileUploadId', sql.UniqueIdentifier, null);
          
          await acknowledgementRequest.query(`
            INSERT INTO oe.EnrollmentAcknowledgements (
              AcknowledgementId, LinkToken, MemberId, ProductId, QuestionId, 
              Response, DigitalSignature, SignedDate, CreatedDate, FileUploadId
            ) VALUES (
              @acknowledgementId, @linkToken, @memberId, @productId, @questionId,
              @response, @digitalSignature, @signedDate, @createdDate, @fileUploadId
            )
          `);
        }
        
        console.log(`✅ Saved ${acknowledgements.length} acknowledgements to database`);
      }
      
      console.log('🔍 Moving to group payment update...');

      // Update group recurring payment amount for group members
      // ⚠️ CRITICAL: Only update if NOT cancelling all plans - no need to update payment when cancelling everything
      // Check if only contribution enrollments remain (which are not real products)
      // This variable is used in multiple places below, so declare it once here
      const hasOnlyContributionEnrollments = productsToEnroll.length > 0 && productsToEnroll.every(pid => pid === '00000000-0000-0000-0000-000000000000');
      const isCancellingAllPlans = removedProducts.length > 0 && (productsToEnroll.length === 0 || hasOnlyContributionEnrollments);
      
      if (member.GroupId && !isCancellingAllPlans) {
        try {
          console.log('🏢 Updating group recurring payment...');

          // Pass the household's billing cohort so an initial-plan insert
          // (when no GroupRecurringPaymentPlan exists yet) lands with the
          // correct BillingDay — 5 for FIRST cohort, 20 for FIFTEENTH.
          // Falls through to FIRST when the household has no active
          // enrollments yet, matching the function's default.
          const updatePromise = GroupPaymentService.updateGroupRecurringPaymentAmount(
            member.GroupId,
            transaction,
            householdCohortForPlanChange || undefined
          );
          
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Group payment update timeout')), 10000)
          );
          
          const updateResult = await Promise.race([updatePromise, timeoutPromise]);
          
          if (updateResult.success) {
            console.log(`✅ Updated group payment: $${updateResult.amount}`);
          } else {
            console.warn(`⚠️ Group payment update failed:`, updateResult.message);
          }
        } catch (error) {
          console.error('❌ Group payment update error:', error.message);
          // Don't fail product changes - just log the error
        }
      } else {
        console.log('ℹ️ Not a group member, skipping group payment update');
      }
      
      // VALIDATION: Compare frontend expectations with backend results
      if (expectedMonthlyTotal !== null || expectedMonthlyTotal !== undefined) {
        console.log('🔍 Validating frontend vs backend results...');
        
        // Get final active product count after changes
        const finalActiveProductsQuery = `
          SELECT COUNT(DISTINCT CASE WHEN ProductBundleID IS NOT NULL THEN ProductBundleID ELSE ProductId END) as ActiveProductCount
          FROM oe.Enrollments
          WHERE MemberId = @memberId
            AND (Status = 'Active' OR Status = 'Pending')
            AND (TerminationDate IS NULL OR TerminationDate > GETDATE())
            AND (EnrollmentType = 'Product' OR EnrollmentType IS NULL)
        `;
        const finalActiveProductsRequest = transaction.request();
        finalActiveProductsRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
        const finalActiveProductsResult = await finalActiveProductsRequest.query(finalActiveProductsQuery);
        const finalActiveProductCount = finalActiveProductsResult.recordset[0]?.ActiveProductCount || 0;
        
        // Calculate backend monthly total using PlanChangeCalculator
        // PlanChangeCalculator is already imported at the top of the file
        const backendCalculation = await PlanChangeCalculator.calculatePlanChangeCost({
          memberId: member.MemberId,
          householdId: member.HouseholdId,
          selectedProducts: productsToEnroll || [],
          removedProducts: removedProducts || [],
          configValues: configValues || {},
          dependentsToAdd: dependentsToAdd || [],
          dependentsToRemove: dependentsToRemove || [],
          newTobaccoUse: newTobaccoUse || null,
          calculatedTier: finalTier || null,
          isGroupMember: !!member.GroupId
        });
        
        const backendMonthlyTotal = backendCalculation.newMonthlyTotal || 0;
        const frontendMonthlyTotal = expectedMonthlyTotal || 0;
        const monthlyTotalDiff = Math.abs(backendMonthlyTotal - frontendMonthlyTotal);
        const monthlyTotalTolerance = 0.01; // Allow $0.01 difference for rounding
        
        console.log('📊 Validation results:', {
          frontendMonthlyTotal,
          backendMonthlyTotal,
          difference: monthlyTotalDiff,
          withinTolerance: monthlyTotalDiff <= monthlyTotalTolerance,
          finalActiveProductCount
        });
        
        // Warn if significant differences (but don't fail - frontend may have different calculation timing)
        if (monthlyTotalDiff > monthlyTotalTolerance) {
          console.warn(`⚠️ Monthly total mismatch: Frontend=${frontendMonthlyTotal.toFixed(2)}, Backend=${backendMonthlyTotal.toFixed(2)}, Diff=${monthlyTotalDiff.toFixed(2)}`);
        }
      }
      
      console.log('🔍 Committing transaction...');

      // 🔒 ACID COMPLIANCE: Commit database transaction FIRST
      await transaction.commit();
      console.log('✅ Database transaction committed successfully');
      
      // 🔒 ACID COMPLIANCE: Activate group member enrollments immediately (no payment required)
      if (isGroupMember && hasEnrollments) {
        console.log('👥 Activating group member enrollments (no payment required)...');
        const pool = await getPool();
        const activateRequest = pool.request();
        activateRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
        
        const activateResult = await activateRequest.query(`
          UPDATE oe.Enrollments
          SET Status = 'Active', ModifiedDate = GETUTCDATE()
          WHERE MemberId = @memberId
            AND Status = 'Pending'
        `);
        
        console.log(`✅ Activated ${activateResult.rowsAffected[0]} group member enrollments (no payment required)`);
      }
      
      // 🔒 ACID COMPLIANCE: Process external services (DIME) AFTER commit
      // This ensures database changes are durable before calling external APIs
      // If payment fails, enrollments are already saved and we can retry payment later
      // ⚠️ CRITICAL: NEVER set up DIME payments for:
      // 1. Group members - they're handled at group level
      // 2. When cancelling all plans - no need for recurring payments
      // Note: isCancellingAllPlans is already declared above (reuse it)
      const shouldSetupPayment = paymentProcessingData && !isGroupMember && !member.GroupId && !isCancellingAllPlans;
      
      if (shouldSetupPayment) {
        console.log('💳 Processing post-commit payment setup...');
        
        try {
          paymentMethodInfo = await handleDimeRecurringPayment(
            paymentProcessingData.memberId,
            paymentProcessingData.frontendPricing,
            null, // No transaction - already committed
            paymentProcessingData.enrollmentId,
            paymentProcessingData.paymentMethod,
            paymentProcessingData.nextEffectiveDate,
            paymentProcessingData.chargeAmount,
            paymentProcessingData.isIncrementalCharge,
            paymentProcessingData.calculatedMonthlyTotal,
            paymentProcessingData.tenantId,
            paymentProcessingData.creditAmount ? {
              creditAmount: paymentProcessingData.creditAmount,
              isNegativeDifference: paymentProcessingData.isNegativeDifference,
              nextBillingCycleStart: paymentProcessingData.nextBillingCycleStart,
              newPremiumTotal: paymentProcessingData.newPremiumTotal
            } : null
          );
          
          console.log('✅ Post-commit payment processing completed');
          
          // 🔒 ACID COMPLIANCE: Activate enrollments ONLY after successful payment
          // This ensures customers ONLY get active coverage if payment succeeds
          console.log('🔓 Activating enrollments after successful payment...');
          const pool = await getPool();
          const activateRequest = pool.request();
          activateRequest.input('householdId', sql.UniqueIdentifier, paymentProcessingData.householdId);
          activateRequest.input('effectiveDate', sql.Date, paymentProcessingData.nextEffectiveDate);
          
          const activateResult = await activateRequest.query(`
            UPDATE oe.Enrollments
            SET Status = 'Active', ModifiedDate = GETUTCDATE()
            WHERE HouseholdId = @householdId
              AND EffectiveDate = @effectiveDate
              AND Status = 'Pending'
          `);
          
          console.log(`✅ Activated ${activateResult.rowsAffected[0]} enrollments after payment success`);
          
        } catch (paymentError) {
          // 🔒 ACID COMPLIANCE: Payment failure AFTER commit
          // Enrollments remain in 'Pending' status - customer has NO active coverage
          console.error('❌ POST-COMMIT PAYMENT FAILED:', paymentError.message);
          console.error('⚠️ CRITICAL: Enrollments created but remain PENDING (payment failed)');
          console.error('🚨 ACTION REQUIRED: Manual payment setup needed for household:', paymentProcessingData.householdId);
          
          // Cleanup: Delete pending enrollments since payment failed
          console.log('🧹 Cleaning up pending enrollments (payment failed)...');
          try {
            const pool = await getPool();
            const cleanupRequest = pool.request();
            cleanupRequest.input('householdId', sql.UniqueIdentifier, paymentProcessingData.householdId);
            cleanupRequest.input('effectiveDate', sql.Date, paymentProcessingData.nextEffectiveDate);
            
            const cleanupResult = await cleanupRequest.query(`
              DELETE FROM oe.Enrollments
              WHERE HouseholdId = @householdId
                AND EffectiveDate = @effectiveDate
                AND Status = 'Pending'
            `);
            
            console.log(`🧹 Deleted ${cleanupResult.rowsAffected[0]} pending enrollments`);
          } catch (cleanupError) {
            console.error('❌ Failed to cleanup pending enrollments:', cleanupError.message);
          }
          
          // Fail the request - enrollment creation failed due to payment failure
          return res.status(500).json({
            success: false,
            message: 'Enrollment failed: Payment processing unsuccessful. Please try again or contact support.',
            error: {
              code: 'PAYMENT_FAILED',
              message: paymentError.message,
              requiresManualSetup: false
            }
          });
        }
      } else if (isCancellingAllPlans && !isGroupMember && !member.GroupId) {
        // Cancel-all for individual households: previously this path skipped DIME entirely,
        // leaving the old schedule live at DIME (kept charging the member) and leaving
        // Active SystemFee/PaymentProcessingFee enrollments that the nightly job turned
        // into orphan fee-only ($3.50) schedules. Tear both down explicitly.
        try {
          const pool = await getPool();

          // 1. Terminate leftover fee enrollments on the primary member
          const feeCleanup = await pool.request()
            .input('householdId', sql.UniqueIdentifier, member.HouseholdId)
            .query(`
              UPDATE e
              SET e.Status = 'Inactive',
                  e.TerminationDate = CAST(GETUTCDATE() AS date),
                  e.ModifiedDate = GETUTCDATE()
              FROM oe.Enrollments e
              INNER JOIN oe.Members m ON m.MemberId = e.MemberId
              WHERE m.HouseholdId = @householdId
                AND (e.EnrollmentType = 'SystemFee' OR e.EnrollmentType = 'PaymentProcessingFee')
                AND (e.Status = 'Active' OR e.Status = 'Pending')
            `);
          console.log(`🧹 Cancel-all: terminated ${feeCleanup.rowsAffected[0]} leftover fee enrollment(s)`);

          // 2. Cancel every Active DIME schedule for this customer (DIME is source of truth)
          const pmRow = await pool.request()
            .input('householdId', sql.UniqueIdentifier, member.HouseholdId)
            .query(`
              SELECT TOP 1 mpm.ProcessorCustomerId
              FROM oe.MemberPaymentMethods mpm
              INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
              WHERE m.HouseholdId = @householdId AND mpm.ProcessorCustomerId IS NOT NULL
              ORDER BY CASE WHEN mpm.Status = 'Active' THEN 0 ELSE 1 END, mpm.CreatedDate DESC
            `);
          const processorCustomerId = pmRow.recordset[0]?.ProcessorCustomerId || null;
          const cancelTenantId = paymentProcessingData?.tenantId || member.TenantId || null;
          if (processorCustomerId && cancelTenantId) {
            const { cancelledIds } = await cancelAllActiveDimeRecurringForCustomer(processorCustomerId, cancelTenantId);
            console.log(`🧹 Cancel-all: cancelled ${cancelledIds.length} active DIME schedule(s):`, cancelledIds);
          } else {
            console.log('🧹 Cancel-all: no ProcessorCustomerId found, skipping DIME schedule cancel');
          }

          // 3. Deactivate our schedule rows
          await pool.request()
            .input('householdId', sql.UniqueIdentifier, member.HouseholdId)
            .query(`
              UPDATE oe.IndividualRecurringSchedules
              SET IsActive = 0, CancelledDate = GETUTCDATE(), ModifiedDate = GETUTCDATE()
              WHERE HouseholdId = @householdId AND ISNULL(IsActive, 1) = 1
            `);
        } catch (cancelAllErr) {
          console.error('❌ Cancel-all DIME/fee teardown failed (manual cleanup may be needed):', cancelAllErr.message);
        }
      }
      
      // Clear the timeout since we're responding successfully
      clearTimeout(requestTimeout);
      
      console.log('🔍 Sending success response...');

      res.json({
        success: true,
        message: 'Product changes completed successfully',
        data: {
          selectedProducts: productsToEnroll || [],
          removedProducts: removedProducts || [],
          configChanges: (configChanges || []).length,
          effectiveDate,
          acknowledgements: {
            count: acknowledgements.length,
            saved: acknowledgements.length > 0,
            hasDigitalSignature: !!digitalSignature
          },
          summary: {
            removed: (removedProducts || []).length,
            added: (productsToEnroll || []).length,
            configUpdated: (configChanges || []).length
          },
          paymentInfo: {
            isGroupMember: !!member.GroupId, // Use actual GroupId from database
            paymentProcessed: !member.GroupId, // Individual members get DIME processing
            chargeAmount: actualChargeAmount,
            isIncrementalCharge: actualIsIncremental,
            futureEnrollmentsAlreadyPaid,
            message: member.GroupId 
              ? 'Payment handled at group level' 
              : actualChargeAmount > 0 
                ? `Payment of $${actualChargeAmount.toFixed(2)} processed successfully${actualIsIncremental ? ' (incremental charge)' : ''}`
                : 'No immediate payment required',
            paymentMethod: paymentMethodInfo ? {
              type: paymentMethodInfo.paymentMethodType,
              last4: paymentMethodInfo.last4,
              cardBrand: paymentMethodInfo.cardBrand,
              amount: paymentMethodInfo.amount,
              scheduleId: paymentMethodInfo.scheduleId
            } : null
          }
        }
      });

    } catch (error) {
      // Only rollback if transaction hasn't been committed yet
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        console.warn('⚠️ Could not rollback transaction (may already be committed):', rollbackError.message);
      }
      throw error;
    }

  } catch (error) {
    console.error('❌ Error completing product changes:', error);
    
    // Clear the timeout
    clearTimeout(requestTimeout);
    
    res.status(500).json({
      success: false,
      message: 'Server error while completing product changes',
      error: error.message
    });
  }
});

// GET /api/me/member/product-changes-complete/acknowledgements - Get acknowledgements for selected products
router.get('/acknowledgements', authorize(['Member', 'SysAdmin', 'TenantAdmin', 'Agent', 'AgencyOwner', 'GroupAdmin']), async (req, res) => {
  try {
    const { selectedProducts } = req.query;

    if (!selectedProducts) {
      return res.status(400).json({
        success: false,
        message: 'Selected products are required'
      });
    }

    const productIds = selectedProducts.split(',').filter(id => id.trim());

    const result = await EnrollmentCompletionService.getProductAcknowledgements(productIds);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }

  } catch (error) {
    console.error('❌ Error getting product acknowledgements:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching acknowledgements',
      error: error.message
    });
  }
});

// Helper function to validate DIME payment exists
async function validateDimePaymentExists(memberId) {
  try {
    const pool = await getPool();
    
    // Get household ID for the member directly from Members table
    const householdQuery = `
      SELECT HouseholdId
      FROM oe.Members
      WHERE MemberId = @memberId
    `;
    
    const householdResult = await pool.request()
      .input('memberId', sql.UniqueIdentifier, memberId)
      .query(householdQuery);
    
    if (householdResult.recordset.length === 0) {
      return { exists: false, error: 'No member found' };
    }
    
    const householdId = householdResult.recordset[0].HouseholdId;
    
    if (!householdId) {
      return { exists: false, error: 'No household ID found for member' };
    }
    
    // Check if there's an active payment method for this member
    const paymentQuery = `
      SELECT 
        mpm.PaymentMethodId,
        mpm.PaymentMethodType,
        mpm.ProcessorToken,
        mpm.ProcessorCustomerId,
        mpm.ProcessorPaymentMethodId,
        mpm.Status,
        mpm.CreatedDate
      FROM oe.MemberPaymentMethods mpm
      WHERE mpm.MemberId = @memberId 
        AND mpm.Status = 'Active'
      ORDER BY mpm.CreatedDate DESC
    `;
    
    const paymentResult = await pool.request()
      .input('memberId', sql.UniqueIdentifier, memberId)
      .query(paymentQuery);
    
    if (paymentResult.recordset.length > 0) {
      const paymentMethod = paymentResult.recordset[0];
      return { 
        exists: true, 
        paymentMethodId: paymentMethod.PaymentMethodId,
        paymentMethodType: paymentMethod.PaymentMethodType,
        processorToken: paymentMethod.ProcessorToken,
        processorCustomerId: paymentMethod.ProcessorCustomerId,
        processorPaymentMethodId: paymentMethod.ProcessorPaymentMethodId,
        createdDate: paymentMethod.CreatedDate
      };
    } else {
      return { exists: false, error: 'No active payment method found for member' };
    }
    
  } catch (error) {
    console.error('❌ Error validating DIME payment existence:', error);
    return { exists: false, error: error.message };
  }
}

// Helper function to process immediate one-time charge
async function processImmediateCharge(memberId, householdId, amount, transaction, existingPaymentMethod = null, tenantId = null, processingFeeAmount = 0) {
  try {
    // 🔒 ACID COMPLIANCE: Support both in-transaction and post-commit execution
    const pool = transaction || await getPool();
    
    let paymentMethod;
    
    // Use existing payment method if provided (avoid re-querying inside transaction)
    if (existingPaymentMethod) {
      console.log('🔍 Using provided payment method (avoiding re-query)');
      paymentMethod = existingPaymentMethod;
    } else {
      // Fallback: Get member's payment method with billing info
      console.log('⚠️ No payment method provided, querying database...');
      const paymentMethodQuery = `
        SELECT 
          PaymentMethodType,
          ProcessorCustomerId,
          ProcessorPaymentMethodId,
          ProcessorToken,
          AccountHolderName,
          CardholderName,
          BillingAddress,
          BillingAddress2,
          BillingCity,
          BillingState,
          BillingZip,
          BillingCountry,
          BankName,
          AccountType,
          RoutingNumberEncrypted,
          AccountNumberEncrypted,
          CardNumberEncrypted,
          ExpiryMonth,
          ExpiryYear
        FROM oe.MemberPaymentMethods
        WHERE MemberId = @memberId 
          AND Status = 'Active'
          AND ProcessorCustomerId IS NOT NULL
          AND ProcessorPaymentMethodId IS NOT NULL
        ORDER BY IsDefault DESC, CreatedDate DESC
      `;
      
      const request = transaction ? transaction.request() : pool.request();
      const paymentMethodResult = await request
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(paymentMethodQuery);
      
      if (paymentMethodResult.recordset.length === 0) {
        throw new Error('No active payment method found for member');
      }
      
      paymentMethod = paymentMethodResult.recordset[0];
    }
    
    // 🔐 Decrypt sensitive data ONLY for ACH (credit cards use tokenized tokens)
    if (paymentMethod.PaymentMethodType === 'ACH' && (paymentMethod.RoutingNumberEncrypted || paymentMethod.AccountNumberEncrypted)) {
      console.log('🔓 Decrypting ACH account data...');
      try {
        const encryptionService = require('../../../services/encryptionService');
        const resolvedRoute = resolveAchRoutingForCharge(
          paymentMethod.RoutingNumber,
          paymentMethod.RoutingNumberEncrypted
        );
        if (resolvedRoute) paymentMethod.RoutingNumber = resolvedRoute;

        if (paymentMethod.AccountNumberEncrypted) {
          const decryptedData = encryptionService.decryptPaymentData({
            accountNumberEncrypted: paymentMethod.AccountNumberEncrypted
          });
          if (decryptedData.accountNumber) {
            paymentMethod.AccountNumber = decryptedData.accountNumber;
            console.log('✅ Account number decrypted');
          }
        }
        console.log('✅ ACH routing resolved / account decrypted for charge');
      } catch (decryptError) {
        console.error('❌ Failed to decrypt ACH account data:', decryptError);
        throw new Error('Failed to decrypt ACH account data for immediate charge');
      }
    } else if (paymentMethod.PaymentMethodType === 'CreditCard' || paymentMethod.PaymentMethodType === 'Card') {
      // Credit cards should use tokenized tokens - no decryption needed!
      console.log('✅ Credit card payment - using stored tokenized token (no decryption needed)');
      if (!paymentMethod.ProcessorToken) {
        throw new Error('Credit card payment method missing required tokenized token (ProcessorToken)');
      }
    }
    
    console.log(`🔍 Processing one-time charge: $${amount}`);
    
    // Validate billing info is complete - NEVER use fallback empty values
    if (!paymentMethod.BillingZip || !paymentMethod.BillingState || !paymentMethod.BillingCity || !paymentMethod.BillingAddress) {
      throw new Error('Payment method missing required billing address information. Please update your payment method with complete billing details.');
    }
    
    // Get account holder name based on payment type
    // Credit cards use CardholderName, ACH uses AccountHolderName
    const holderName = paymentMethod.PaymentMethodType === 'ACH' 
      ? paymentMethod.AccountHolderName 
      : paymentMethod.CardholderName;
    
    if (!holderName) {
      throw new Error(`Payment method missing ${paymentMethod.PaymentMethodType === 'ACH' ? 'account holder' : 'cardholder'} name`);
    }
    
    const nameParts = holderName.split(' ');
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ');
    
    if (!firstName || !lastName) {
      throw new Error('Payment method holder name must include first and last name');
    }
    
    // Process one-time payment through DIME using processPayment
    // For ACH: Use raw decrypted data (DIME requirement)
    // For Credit Card: Use token if available, otherwise payment_method_id
    let paymentResult;
    
    if (paymentMethod.PaymentMethodType === 'ACH') {
      console.log('💳 Processing ACH payment with raw account data');
      
      if (!paymentMethod.RoutingNumber || !paymentMethod.AccountNumber) {
        throw new Error('ACH payment method missing required decrypted routing/account numbers');
      }
      
      paymentResult = await DimeService.processPayment({
        customerId: paymentMethod.ProcessorCustomerId,
        amount: amount,
        description: `First month payment for new/changed enrollments`,
        invoiceNumber: `PLAN-CHANGE-${householdId}-${Date.now()}`,
        // Raw ACH data (decrypted)
        routingNumber: paymentMethod.RoutingNumber,
        accountNumber: paymentMethod.AccountNumber,
        accountType: paymentMethod.AccountType || 'Checking',
        accountHolderName: paymentMethod.AccountHolderName,
        bankName: paymentMethod.BankName || 'Bank',
        // Include billing address
        billingAddress: paymentMethod.BillingAddress,
        billingCity: paymentMethod.BillingCity,
        billingState: paymentMethod.BillingState,
        billingZip: paymentMethod.BillingZip,
        billingFirstName: firstName,
        billingLastName: lastName
      }, tenantId);
    } else {
      console.log('💳 Processing credit card payment with token');
      
      // For credit cards, use token if available, otherwise use payment_method_id
      const paymentData = {
        customerId: paymentMethod.ProcessorCustomerId,
        amount: amount,
        description: `First month payment for new/changed enrollments`,
        invoiceNumber: `PLAN-CHANGE-${householdId}-${Date.now()}`,
        // Include billing address
        billingAddress: paymentMethod.BillingAddress,
        billingCity: paymentMethod.BillingCity,
        billingState: paymentMethod.BillingState,
        billingZip: paymentMethod.BillingZip,
        billingFirstName: firstName,
        billingLastName: lastName
      };
      
      // DIME requires cardholder_name for all credit card charges
      paymentData.cardholderName = paymentMethod.CardholderName;
      
      // If we have a tokenized token (PCI compliant), use it
      if (paymentMethod.ProcessorToken) {
        console.log('✅ Using stored tokenized token for credit card payment (PCI compliant)');
        paymentData.token = paymentMethod.ProcessorToken;
      } else {
        // No token available - this shouldn't happen with proper tokenization
        throw new Error('Credit card payment method missing tokenized token. Please re-add your payment method.');
      }
      
      paymentResult = await DimeService.processPayment(paymentData, tenantId);
    }
    
    if (!paymentResult.success) {
      throw new Error(`DIME payment failed: ${paymentResult.error || 'Unknown error'}`);
    }
    
    console.log(`✅ One-time charge processed successfully: $${amount}`);
    
    // Record the payment in database
    await PaymentDatabaseService.storePaymentRecord({
      enrollmentId: null, // One-time charge not tied to specific enrollment
      householdId,
      amount,
      status: paymentResult.recordStatus || 'succeeded',
      paymentMethod: paymentMethod.PaymentMethodType || 'Card',
      processorTransactionId: paymentResult.transactionId,
      processorResponse: JSON.stringify(paymentResult),
      paymentDate: new Date(),
      processingFeeAmount: processingFeeAmount
    }, transaction);
    
    return paymentResult;
    
  } catch (error) {
    console.error('❌ Error processing immediate charge:', error);
    throw error;
  }
}

/** DIME recurring-payment/list row → schedule id string for cancel API */
function dimeListRowScheduleId(sch) {
  return String(sch?.id ?? sch?.recurring_payment_id ?? sch?.uuid ?? '').trim();
}

/**
 * Cancel every Active recurring schedule in DIME for this customer (plan changes, amount updates).
 * Source of truth is DIME — not oe.Payments alone, since first charge may not have posted yet.
 */
async function cancelAllActiveDimeRecurringForCustomer(processorCustomerId, tenantId) {
  const cancelledIds = [];
  if (!processorCustomerId || !tenantId) {
    return { cancelledIds, listFailed: false };
  }
  const listResult = await DimeService.listRecurringPaymentsForCustomer(
    String(processorCustomerId).trim(),
    tenantId,
    { status: 'Active' }
  );
  if (!listResult.success) {
    console.warn('⚠️ listRecurringPaymentsForCustomer failed (will try Payments fallback):', listResult.error);
    return { cancelledIds, listFailed: true };
  }
  for (const sch of listResult.schedules || []) {
    const st = String(sch.status || '').trim().toLowerCase();
    if (st !== 'active') continue;
    const sid = dimeListRowScheduleId(sch);
    if (!sid) continue;
    console.log(`🔍 Canceling active DIME schedule from customer list (Schedule ID: ${sid})`);
    await cancelExistingDimePayment(sid, tenantId);
    cancelledIds.push(sid);
  }
  return { cancelledIds, listFailed: false };
}

// Helper function to handle DIME recurring payment (update existing or create new)
async function handleDimeRecurringPayment(memberId, frontendPricing, transaction, enrollmentId = null, frontendPaymentMethod = null, effectiveDate = null, chargeAmount = null, isIncrementalCharge = false, calculatedMonthlyTotal = null, tenantId = null, creditInfo = null) {
  try {
    // 🔒 ACID COMPLIANCE: Support both in-transaction and post-commit execution
    const pool = transaction || await getPool();
    
    // Get household ID for the member directly from Members table
    const householdQuery = `
      SELECT HouseholdId
      FROM oe.Members
      WHERE MemberId = @memberId
    `;
    
    const request = transaction ? transaction.request() : pool.request();
    const householdResult = await request
      .input('memberId', sql.UniqueIdentifier, memberId)
      .query(householdQuery);
    
    if (householdResult.recordset.length === 0) {
      console.log('⚠️ No member found, skipping DIME payment handling');
      return;
    }
    
    const householdId = householdResult.recordset[0].HouseholdId;
    
    if (!householdId) {
      console.log('⚠️ No household ID found for member, skipping DIME payment handling');
      return;
    }
    
    // Use the verified calculatedMonthlyTotal if provided, otherwise calculate from frontend pricing
    // This ensures we use the same amount that was verified against the user's confirmation
    const newTotalAmount = calculatedMonthlyTotal !== null ? calculatedMonthlyTotal : frontendPricing.reduce((total, item) => {
      return total + (parseFloat(item.monthlyPremium) || 0);
    }, 0);
    
    // Use provided chargeAmount or default to newTotalAmount
    const immediateChargeAmount = chargeAmount !== null ? chargeAmount : newTotalAmount;
    
    // Calculate processing fee for immediate charge
    let immediateProcessingFee = 0;
    let recurringProcessingFee = 0;

    // Get tenant's payment processor settings for processing fee calculation
    const tenantQuery = `SELECT PaymentProcessorSettings FROM oe.Tenants WHERE TenantId = @tenantId`;
    const tenantRequest = transaction ? transaction.request() : pool.request();
    const tenantResult = await tenantRequest
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(tenantQuery);

    let paymentProcessorSettings = null;
    if (tenantResult.recordset.length > 0 && tenantResult.recordset[0].PaymentProcessorSettings) {
      try {
        paymentProcessorSettings = JSON.parse(tenantResult.recordset[0].PaymentProcessorSettings);
      } catch (e) {
        console.warn('⚠️ Failed to parse PaymentProcessorSettings:', e);
      }
    }

    // Calculate processing fees
    const processingFeeCalculator = require('../../utils/processingFeeCalculator');
    const productProcessingFeesUtil = require('../../utils/productProcessingFees');
    const paymentMethodType = frontendPaymentMethod?.paymentMethodType || 'Card';

    // ZeroFeeForACH: per-product fee flags must be honored here because this is a WRITE path -
    // `immediateProcessingFee` and `recurringProcessingFee` become the real amounts charged to
    // the payment processor. Without the split, a ShareWELL-like product with the flag set would
    // be charged at the full ACH rate instead of $0 under ACH.
    const productIdsInChange = Array.from(new Set(
      (frontendPricing || []).map(p => p?.productId).filter(Boolean)
    ));
    const subscriptionFeeSettingsByProductId = productIdsInChange.length > 0
      ? await productProcessingFeesUtil.loadSubscriptionFeeSettingsByProductId({
          poolOrTransaction: transaction || pool,
          tenantId,
          productIds: productIdsInChange
        })
      : new Map();

    // Compute the recurring fee from the real per-product premium map (handles included/normal/zero-ACH correctly).
    const recurringBasePremiumByProductId = new Map();
    for (const item of (frontendPricing || [])) {
      const pid = String(item?.productId || '');
      if (!pid) continue;
      const amt = Number(item?.monthlyPremium || 0);
      if (amt <= 0) continue;
      recurringBasePremiumByProductId.set(pid, Math.round((Number(recurringBasePremiumByProductId.get(pid) || 0) + amt) * 100) / 100);
    }
    // Phase 5.4 — single-source fee composition via pricingAuthority.
    const pricingAuthorityForRecurring = require('../../../services/pricing/pricingAuthority.service');
    const recurringPricingProducts = Array.from(recurringBasePremiumByProductId.entries())
      .map(([productId, monthlyPremium]) => ({ productId, monthlyPremium: Number(monthlyPremium || 0) }));
    const recurringAuthorityOutput = await pricingAuthorityForRecurring.computePricing({
      poolOrTransaction: transaction || pool,
      tenantId,
      pricingProducts: recurringPricingProducts,
      paymentMethodType
    });
    recurringProcessingFee = Number(recurringAuthorityOutput.totals.nonIncludedFeeTotal || 0);

    // For the immediate (prorated) charge: scale the recurring processing fee by the ratio of
    // immediate / newTotalAmount. This preserves the same ZeroFeeForACH-aware treatment without
    // per-product proration data. When immediate == newTotal, result is identical to recurring.
    if (newTotalAmount > 0 && immediateChargeAmount > 0) {
      const ratio = Number(immediateChargeAmount) / Number(newTotalAmount);
      immediateProcessingFee = Math.round(recurringProcessingFee * ratio * 100) / 100;
    }
    
    const immediateChargeWithFee = immediateChargeAmount + immediateProcessingFee;
    const recurringAmountWithFee = newTotalAmount + recurringProcessingFee;
    
    console.log(`💰 Payment Summary:`, {
      immediateCharge: immediateChargeAmount,
      immediateProcessingFee: immediateProcessingFee,
      immediateChargeWithFee: immediateChargeWithFee,
      recurringAmount: newTotalAmount,
      recurringProcessingFee: recurringProcessingFee,
      recurringAmountWithFee: recurringAmountWithFee,
      isIncremental: isIncrementalCharge,
      effectiveDate: effectiveDate
    });
    
    // Process immediate charge if amount > 0
    if (immediateChargeAmount > 0) {
      console.log(`💳 Processing immediate charge: $${immediateChargeWithFee} (base: $${immediateChargeAmount} + fee: $${immediateProcessingFee}) (${isIncrementalCharge ? 'incremental' : 'full'})`);
      
      try {
      // Pass the payment method we already fetched to avoid re-querying inside transaction
      await processImmediateCharge(memberId, householdId, immediateChargeWithFee, transaction, frontendPaymentMethod, tenantId, immediateProcessingFee);
      } catch (chargeError) {
        // If immediate charge fails for stored credit cards, that's okay - the recurring payment will handle it
        console.warn(`⚠️ Immediate charge failed:`, chargeError.message);
        console.log(`💡 Continuing with enrollment - recurring payment schedule will process first payment on effective date`);
        // Don't throw - allow enrollment to proceed
      }
    } else {
      console.log('⚠️ No immediate charge needed (amount is $0)');
    }
    
    // Cancel ALL Active recurring schedules in DIME for this customer before creating a new one.
    // Relying only on getRecurringPaymentSchedule (oe.Payments) missed pre-first-charge households:
    // placeholders use Status = RecurringScheduled and were excluded → old DIME schedule stayed live
    // (duplicate ACH on next run — e.g. old premium + new premium same day).
    const pmCustomerResult = await pool.request()
      .input('memberId', sql.UniqueIdentifier, memberId)
      .query(`
        SELECT TOP 1 ProcessorCustomerId
        FROM oe.MemberPaymentMethods
        WHERE MemberId = @memberId AND Status = 'Active' AND ProcessorCustomerId IS NOT NULL
        ORDER BY IsDefault DESC, CreatedDate DESC
      `);
    const processorCustomerId = pmCustomerResult.recordset?.[0]?.ProcessorCustomerId || null;

    const { cancelledIds, listFailed } = await cancelAllActiveDimeRecurringForCustomer(
      processorCustomerId,
      tenantId
    );
    if (listFailed || cancelledIds.length === 0) {
      const existingSchedule = await DimeService.getRecurringPaymentSchedule(householdId, tenantId);
      if (existingSchedule.success && existingSchedule.scheduleId) {
        const sid = String(existingSchedule.scheduleId);
        if (!cancelledIds.some((c) => String(c) === sid)) {
          console.log(`🔍 Fallback: canceling recurring from latest oe.Payments row (Schedule ID: ${sid})`);
          await cancelExistingDimePayment(sid, tenantId);
        }
      }
    } else {
      console.log(`✅ Canceled ${cancelledIds.length} active DIME recurring schedule(s) before creating replacement`);
    }

    try {
      await pool.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .query(`
          UPDATE oe.IndividualRecurringSchedules
          SET IsActive = 0, ModifiedDate = GETUTCDATE()
          WHERE HouseholdId = @householdId AND ISNULL(IsActive, 1) = 1
        `);
    } catch (irsErr) {
      console.warn('⚠️ Could not deactivate IndividualRecurringSchedules rows:', irsErr.message);
    }

    // Create new recurring payment with the FULL total amount (including processing fee)
    const paymentMethodInfo = await createNewDimeRecurringPayment(memberId, householdId, recurringAmountWithFee, transaction, enrollmentId, frontendPaymentMethod, effectiveDate, isIncrementalCharge, calculatedMonthlyTotal, tenantId, recurringProcessingFee, creditInfo);
    
    return paymentMethodInfo;
    
  } catch (error) {
    console.error('❌ Error handling DIME recurring payment:', error);
    // DIME payment failure should block product changes for individual members
    throw new Error(`Payment processing failed: ${error.message}`);
  }
}

// Helper function to cancel existing DIME recurring payment
async function cancelExistingDimePayment(scheduleId, tenantId) {
  try {
    console.log(`🔍 Canceling DIME recurring payment (Schedule ID: ${scheduleId})`);
    
    const cancelResult = await DimeService.cancelRecurringPayment(scheduleId, tenantId);
    
    if (cancelResult.success) {
      console.log(`✅ Successfully canceled DIME recurring payment (Schedule ID: ${scheduleId})`);
    } else {
      console.log(`⚠️ Failed to cancel DIME recurring payment, but continuing with new creation:`, cancelResult.error);
      // Don't throw error - we'll create a new one anyway
    }
    
  } catch (error) {
    console.error('❌ Error canceling existing DIME payment:', error);
    // Don't throw error - we'll create a new one anyway
    console.log('⚠️ Continuing with new recurring payment creation despite cancel error');
  }
}

// Helper function to create new DIME recurring payment (no initial charge)
// NEW: Supports dual recurring payments for credit scenarios (one-time + ongoing)
async function createNewDimeRecurringPayment(memberId, householdId, amount, transaction, enrollmentId = null, frontendPaymentMethod = null, effectiveDate = null, isIncrementalCharge = false, calculatedMonthlyTotal = null, tenantId = null, processingFeeAmount = 0, creditInfo = null) {
  try {
    // 🔒 ACID COMPLIANCE: Support both in-transaction and post-commit execution
    const pool = transaction || await getPool();
    
    // Get member's default payment method with DIME tokens (no sensitive data)
    const paymentMethodQuery = `
      SELECT 
        mpm.PaymentMethodId,
        mpm.ProcessorCustomerId,
        mpm.ProcessorPaymentMethodId,
        mpm.PaymentMethodType,
        mpm.ProcessorToken,
        mpm.BankName,
        mpm.AccountType,
        mpm.RoutingNumber,
        mpm.AccountNumberLast4,
        mpm.AccountHolderName,
        mpm.BillingAddress,
        mpm.BillingAddress2,
        mpm.BillingCity,
        mpm.BillingState,
        mpm.BillingZip,
        mpm.BillingCountry
      FROM oe.MemberPaymentMethods mpm
      WHERE mpm.MemberId = @memberId 
        AND mpm.Status = 'Active'
        AND mpm.ProcessorCustomerId IS NOT NULL
        AND mpm.ProcessorPaymentMethodId IS NOT NULL
      ORDER BY mpm.IsDefault DESC, mpm.CreatedDate DESC
    `;
    
    const request = transaction ? transaction.request() : pool.request();
    const paymentMethodResult = await request
      .input('memberId', sql.UniqueIdentifier, memberId)
      .query(paymentMethodQuery);
    
    if (paymentMethodResult.recordset.length === 0) {
      throw new Error('No active payment method found for member');
    }
    
    const paymentMethod = paymentMethodResult.recordset[0];
    
    console.log(`🔍 Setting up recurring payment: $${amount}/month`);
    console.log(`🔍 Using payment method:`, {
      paymentMethodType: paymentMethod.PaymentMethodType,
      processorPaymentMethodId: paymentMethod.ProcessorPaymentMethodId,
      processorToken: paymentMethod.ProcessorToken ? `${paymentMethod.ProcessorToken.substring(0, 4)}****` : null
    });
    
    // Calculate recurring payment start date
    // Since we charged immediately for the first month (effective date through end of that month),
    // the recurring payment should start exactly 1 month after the effective date
    // Use simple string math to avoid timezone issues (per backend-system.md)
    let recurringStartDateStr;
    let firstMonthEndsStr;
    
    if (effectiveDate) {
      const [year, month, day] = effectiveDate.split('-').map(Number);
      
      // Calculate 1 month after effective date
      let newMonth = month + 1;
      let newYear = year;
      if (newMonth > 12) {
        newMonth = 1;
        newYear++;
      }
      recurringStartDateStr = `${newYear}-${String(newMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      
      // Calculate last day of first month (day before recurring starts)
      let endMonth = month + 1;
      let endYear = year;
      if (endMonth > 12) {
        endMonth = 1;
        endYear++;
      }
      // Get last day of month by using day 0 of next month
      const lastDay = new Date(endYear, endMonth, 0).getDate();
      firstMonthEndsStr = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    } else {
      const nextMonth = new Date();
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      recurringStartDateStr = nextMonth.toISOString().split('T')[0];
      firstMonthEndsStr = null;
    }
    
    // Convert to Date object for DIME API
    const recurringStartDate = new Date(recurringStartDateStr + 'T00:00:00Z');
    
    console.log(`🔍 Recurring payment calculation:`, {
      effectiveDate: effectiveDate,
      firstMonthEnds: firstMonthEndsStr,
      recurringStartDate: recurringStartDateStr,
      recurringAmount: amount,
      isIncrementalCharge: isIncrementalCharge
    });
    
    // CRITICAL: Validate that recurring amount matches what we verified with the user
    if (calculatedMonthlyTotal !== null && Math.abs(amount - calculatedMonthlyTotal) > 0.01) {
      throw new Error(`CRITICAL: Recurring amount mismatch! Attempting to set up $${amount}/month but verified amount is $${calculatedMonthlyTotal}/month`);
    }
    
    // NEW: Handle dual recurring payments for credit scenarios (per plan-changes-logic.md)
    if (creditInfo && creditInfo.creditAmount > 0) {
      console.log('💰 Setting up dual recurring payments for credit scenario...', {
        creditAmount: creditInfo.creditAmount,
        isNegativeDifference: creditInfo.isNegativeDifference,
        nextBillingCycleStart: creditInfo.nextBillingCycleStart?.toISOString().split('T')[0],
        newPremiumTotal: creditInfo.newPremiumTotal
      });
      
      // Payment 1: One-time payment for next billing cycle only (with credit adjustment)
      const nextBillingCycleStart = new Date(creditInfo.nextBillingCycleStart);
      const nextBillingCycleEnd = new Date(nextBillingCycleStart);
      nextBillingCycleEnd.setDate(nextBillingCycleEnd.getDate() + 1); // 1 day duration
      
      let payment1Amount = amount; // Default to full amount
      if (creditInfo.isNegativeDifference) {
        // Negative difference: member gets credit, so payment is reduced
        payment1Amount = creditInfo.newPremiumTotal - creditInfo.creditAmount;
      } else {
        // Positive difference: member owes more, so payment is increased
        payment1Amount = creditInfo.newPremiumTotal; // Or amount + creditAmount
      }
      
      // Get payment processor settings for processing fee calculation
      const tenantQuery = `SELECT PaymentProcessorSettings FROM oe.Tenants WHERE TenantId = @tenantId`;
      const tenantRequest = transaction ? transaction.request() : pool.request();
      const tenantResult = await tenantRequest
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(tenantQuery);
      
      let paymentProcessorSettings = null;
      if (tenantResult.recordset.length > 0 && tenantResult.recordset[0].PaymentProcessorSettings) {
        try {
          paymentProcessorSettings = JSON.parse(tenantResult.recordset[0].PaymentProcessorSettings);
        } catch (e) {
          console.warn('⚠️ Failed to parse PaymentProcessorSettings:', e);
        }
      }
      
      // ZeroFeeForACH: scale the fee proportionally from the already-correct recurring processing fee
      // computed upstream (which handled the two-pool split). This keeps dual-payment math aligned
      // with the monthly recurring fee and avoids recomputing without per-product context.
      // `processingFeeAmount` here = recurringProcessingFee from the outer function (already honors ZeroFeeForACH).
      const feePerDollar = (creditInfo?.newPremiumTotal && creditInfo.newPremiumTotal > 0)
        ? (Number(processingFeeAmount || 0) / Number(creditInfo.newPremiumTotal))
        : 0;

      const payment1ProcessingFee = Math.round(Number(payment1Amount || 0) * feePerDollar * 100) / 100;
      const payment1Total = payment1Amount + payment1ProcessingFee;
      
      console.log('💳 Creating Payment 1 (one-time for next billing cycle):', {
        amount: payment1Amount,
        processingFee: payment1ProcessingFee,
        total: payment1Total,
        startDate: nextBillingCycleStart.toISOString().split('T')[0],
        endDate: nextBillingCycleEnd.toISOString().split('T')[0]
      });
      
      const payment1Result = await DimeService.setupRecurringPayment({
        customerId: paymentMethod.ProcessorCustomerId,
        paymentMethodId: paymentMethod.ProcessorPaymentMethodId,
        amount: payment1Total,
        description: `One-time payment for product changes (with credit adjustment) - $${payment1Total}`,
        householdId: householdId,
        startDate: nextBillingCycleStart,
        endDate: nextBillingCycleEnd // 1 day only
      }, tenantId);
      
      if (!payment1Result.success) {
        throw new Error(`One-time payment setup failed: ${payment1Result.error}`);
      }
      
      console.log(`✅ Payment 1 (one-time) setup successfully: $${payment1Total} for ${nextBillingCycleStart.toISOString().split('T')[0]} only (Schedule ID: ${payment1Result.scheduleId})`);
      
      // Payment 2: Normal recurring payment starting month after next billing cycle
      const payment2StartDate = new Date(nextBillingCycleStart);
      payment2StartDate.setMonth(payment2StartDate.getMonth() + 1);
      
      // Payment 2 uses the new premium total (no credit adjustment). Same ZeroFeeForACH-aware scaling.
      const payment2Amount = creditInfo.newPremiumTotal;
      const payment2ProcessingFee = Math.round(Number(payment2Amount || 0) * feePerDollar * 100) / 100;
      const payment2Total = payment2Amount + payment2ProcessingFee;
      
      console.log('💳 Creating Payment 2 (normal recurring):', {
        amount: payment2Amount,
        processingFee: payment2ProcessingFee,
        total: payment2Total,
        startDate: payment2StartDate.toISOString().split('T')[0],
        endDate: null // Ongoing
      });
      
      const payment2Result = await DimeService.setupRecurringPayment({
        customerId: paymentMethod.ProcessorCustomerId,
        paymentMethodId: paymentMethod.ProcessorPaymentMethodId,
        amount: payment2Total,
        description: `Recurring payment for product changes - $${payment2Total}/month`,
        householdId: householdId,
        startDate: payment2StartDate
        // No endDate = ongoing
      }, tenantId);
      
      if (!payment2Result.success) {
        throw new Error(`Recurring payment setup failed: ${payment2Result.error}`);
      }
      
      console.log(`✅ Payment 2 (recurring) setup successfully: $${payment2Total}/month starting ${payment2StartDate.toISOString().split('T')[0]} (Schedule ID: ${payment2Result.scheduleId})`);
      
      // Persist to oe.IndividualRecurringSchedules — without this row the schedule is
      // an orphan our audits/cancel flows can't see (caused real double-charges).
      try {
        await PaymentDatabaseService.persistRecurringScheduleAfterDimeSetup({
          householdId,
          tenantId,
          recurringScheduleId: payment2Result.scheduleId,
          nextBillingDate: payment2Result.nextBillingDate || payment2StartDate,
          monthlyAmount: payment2Total
        });
      } catch (persistErr) {
        console.error('⚠️ Could not persist recurring schedule row (payment2):', persistErr.message);
      }
      
      return {
        success: true,
        paymentMethodInfo: {
          paymentMethodId: paymentMethod.PaymentMethodId,
          processorPaymentMethodId: paymentMethod.ProcessorPaymentMethodId,
          paymentMethodType: paymentMethod.PaymentMethodType,
          last4: paymentMethod.AccountNumberLast4,
          cardBrand: paymentMethod.PaymentMethodType === 'CreditCard' ? 'Visa' : null
        },
        recurringScheduleId: payment2Result.scheduleId, // Return the ongoing recurring payment ID
        nextBillingDate: payment2Result.nextBillingDate,
        creditPaymentInfo: {
          oneTimeScheduleId: payment1Result.scheduleId,
          oneTimeAmount: payment1Total,
          oneTimeDate: nextBillingCycleStart.toISOString().split('T')[0]
        }
      };
    }
    
    // Standard recurring payment (no credit scenario)
    const recurringResult = await DimeService.setupRecurringPayment({
      customerId: paymentMethod.ProcessorCustomerId,
      paymentMethodId: paymentMethod.ProcessorPaymentMethodId,
      amount: amount,
      description: `Recurring payment for product changes - $${amount}/month`,
      householdId: householdId,
      startDate: recurringStartDate
    }, tenantId);
    
    if (!recurringResult.success) {
      throw new Error(`Recurring payment setup failed: ${recurringResult.error}`);
    }
    
    // DIME doesn't return the amount in the response, but we already validated it before sending
    // The amount validation happened at line 1722 before calling DimeService.setupRecurringPayment
    console.log(`✅ Recurring payment setup successfully: $${amount}/month starting ${recurringStartDate.toISOString().split('T')[0]} (Schedule ID: ${recurringResult.scheduleId})`);
    
    // Persist to oe.IndividualRecurringSchedules — without this row the schedule is
    // an orphan our audits/cancel flows can't see (caused real double-charges).
    try {
      await PaymentDatabaseService.persistRecurringScheduleAfterDimeSetup({
        householdId,
        tenantId,
        recurringScheduleId: recurringResult.scheduleId,
        nextBillingDate: recurringResult.nextBillingDate || recurringStartDate,
        monthlyAmount: amount
      });
    } catch (persistErr) {
      console.error('⚠️ Could not persist recurring schedule row:', persistErr.message);
    }
    
    return {
      success: true,
      paymentMethodInfo: {
        paymentMethodId: paymentMethod.PaymentMethodId,
        processorPaymentMethodId: paymentMethod.ProcessorPaymentMethodId,
      paymentMethodType: paymentMethod.PaymentMethodType,
        last4: paymentMethod.AccountNumberLast4,
        cardBrand: paymentMethod.PaymentMethodType === 'CreditCard' ? 'Visa' : null
      },
      recurringScheduleId: recurringResult.scheduleId,
      nextBillingDate: recurringResult.nextBillingDate
    };
    
  } catch (error) {
    console.error('❌ Error setting up DIME recurring payment:', error);
    throw error;
  }
}

// Helper function to calculate backend pricing for validation
async function calculateBackendPricing(selectedProducts, configValues, memberId, effectiveDate, calculatedTier = null, newTobaccoUse = null, dependentsToAdd = [], dependentsToRemove = []) {
  try {
    // Get member and group information
    const pool = await getPool();
    const memberQuery = `
      SELECT m.MemberId, m.GroupId, m.DateOfBirth, m.Gender, m.TobaccoUse, m.Tier,
             u.FirstName, u.LastName, g.Name as GroupName, g.TenantId
      FROM oe.Members m
      JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
      WHERE m.MemberId = @memberId
    `;
    
    const memberResult = await pool.request()
      .input('memberId', sql.UniqueIdentifier, memberId)
      .query(memberQuery);
    
    if (memberResult.recordset.length === 0) {
      throw new Error('Member not found');
    }
    
    const member = memberResult.recordset[0];
    
    // Get household members to calculate tier from PROSPECTIVE household composition
    // This includes dependents being added and excludes dependents being removed
    // This ensures we use the correct tier for the projected household state
    const householdMembersQuery = `
      SELECT 
        MemberId,
        RelationshipType,
        CASE 
          WHEN UserId = (SELECT UserId FROM oe.Members WHERE MemberId = @memberId) THEN 1 
          ELSE 0 
        END as IsCurrentUser
      FROM oe.Members
      WHERE HouseholdId = (SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId)
        AND Status = 'Active'
    `;
    const householdMembersResult = await pool.request()
      .input('memberId', sql.UniqueIdentifier, memberId)
      .query(householdMembersQuery);
    
    let householdMembers = householdMembersResult.recordset;
    
    // Build prospective household: remove dependents being removed, add dependents being added
    if (dependentsToRemove && dependentsToRemove.length > 0) {
      householdMembers = householdMembers.filter(m => !dependentsToRemove.includes(m.MemberId));
    }
    
    // Add prospective dependents to household for tier calculation
    const prospectiveHouseholdMembers = [...householdMembers];
    if (dependentsToAdd && dependentsToAdd.length > 0) {
      for (const dependent of dependentsToAdd) {
        // Map relationship type from frontend format to database format
        prospectiveHouseholdMembers.push({
          MemberId: null, // New member, doesn't have ID yet
          RelationshipType: dependent.relationshipType || 'C',
          IsCurrentUser: 0
        });
      }
    }
    
    const TierCalculator = require('../../../services/pricing/TierCalculator');
    const calculatedTierFromHousehold = TierCalculator.calculateTierFromHousehold(prospectiveHouseholdMembers, memberId);
    
    const householdSize = prospectiveHouseholdMembers.length;
    
    // CRITICAL: Use tier calculated from PROSPECTIVE household composition (including dependents being added)
    const tierToUse = calculatedTierFromHousehold;
    const tobaccoToUse = newTobaccoUse || member.TobaccoUse || 'No';
    
    console.log('🔍 DEBUG: Backend pricing using tier/tobacco:', {
      frontendCalculatedTier: calculatedTier,
      calculatedTierFromHousehold,
      memberCurrentTier: member.Tier,
      tierToUse,
      newTobaccoUse,
      tobaccoToUse,
      householdSize,
      memberCurrentTobacco: member.TobaccoUse,
      currentHouseholdSize: householdMembersResult.recordset.length,
      dependentsToAddCount: dependentsToAdd?.length || 0,
      dependentsToRemoveCount: dependentsToRemove?.length || 0,
      prospectiveHouseholdSize: prospectiveHouseholdMembers.length
    });
    
    // Get group contribution rules
    const contributionQuery = `
      SELECT 
        gc.ContributionId,
        gc.ProductId,
        gc.Name,
        gc.ContributionType,
        gc.FlatRateAmount,
        gc.PercentageAmount,
        gc.Priority,
        gc.Stacking,
        gc.Status
      FROM oe.GroupContributions gc
      WHERE gc.GroupId = @groupId AND gc.Status = 'Active'
      ORDER BY gc.Priority ASC
    `;
    
    const contributionResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, member.GroupId)
      .query(contributionQuery);
    
    const groupContributionRules = contributionResult.recordset.map(rule => ({
      type: rule.ContributionType === 'flat_rate' ? 'flat_rate' : 'percentage',
      amount: rule.ContributionType === 'flat_rate' ? rule.FlatRateAmount : rule.PercentageAmount,
      description: rule.Name || '',
      appliesTo: rule.ProductId ? 'product' : 'all_products',
      productId: rule.ProductId
    }));
    
    // Get product details with pricing from TenantProductSubscriptions
    const productQuery = `
      SELECT p.ProductId, p.Name, p.ProductType, p.VendorProductID, tps.SalePrice as BasePrice
      FROM oe.Products p
      LEFT JOIN oe.TenantProductSubscriptions tps ON p.ProductId = tps.ProductId AND tps.TenantId = @tenantId
      WHERE p.ProductId IN (${selectedProducts.map((_, index) => `@product${index}`).join(',')})
    `;
    
    const productRequest = pool.request();
    productRequest.input('tenantId', sql.UniqueIdentifier, member.TenantId);
    selectedProducts.forEach((productId, index) => {
      productRequest.input(`product${index}`, sql.UniqueIdentifier, productId);
    });
    
    const productResult = await productRequest.query(productQuery);
    const products = productResult.recordset;
    
    console.log('🔍 DEBUG: Backend product query results:', {
      selectedProducts,
      productsFound: products.length,
      products: products.map(p => ({ ProductId: p.ProductId, Name: p.Name, ProductType: p.ProductType }))
    });
    
    // Calculate pricing for each product
    const backendPricing = [];
    
    for (const product of products) {
      // For bundles, look for bundle configuration keys (bundleId-subProductId)
      // For individual products, use the product ID directly
      let configValue = configValues[product.ProductId] || 'Default';
      
      // If it's a bundle and no direct config found, look for bundle config keys
      if (product.ProductType === 'Bundle' && configValue === 'Default') {
        const bundleConfigKeys = Object.keys(configValues).filter(key => 
          key.startsWith(product.ProductId + '-')
        );
        
        if (bundleConfigKeys.length > 0) {
          // Extract the config value from the first bundle sub-product config
          configValue = configValues[bundleConfigKeys[0]];
          console.log(`🔍 DEBUG: Using bundle config from sub-product key: ${bundleConfigKeys[0]} = ${configValue}`);
        }
      }
      
      // Calculate pricing using PricingEngine
      console.log('🔍 DEBUG: Calculating pricing for product:', {
        productId: product.ProductId,
        productName: product.Name,
        productType: product.ProductType,
        configValue,
        isBundle: product.ProductType === 'Bundle',
        memberAge: getMemberAgeForPricing(member.DateOfBirth, 35),
        tobaccoUse: tobaccoToUse,
        tier: tierToUse
      });
      
      let pricingResult;
      
      // Use different pricing method for bundles vs individual products
      if (product.ProductType === 'Bundle') {
        // For bundles, use the main calculatePricing method
        const bundleResults = await PricingEngine.calculatePricing({
          calculationType: 'enrollment',
          memberId: memberId, // Pass memberId to enable tier recalculation from household
          memberCriteria: {
            age: getMemberAgeForPricing(member.DateOfBirth, 35),
            tobaccoUse: tobaccoToUse,
            tier: tierToUse,
            householdSize: householdSize
          },
          productSelections: [{
            productId: product.ProductId,
            configValues: { configValue1: configValue }
          }],
          groupId: member.GroupId || null,
          effectiveDate: effectiveDate || null // Pass effective date to select correct pricing tiers based on date
        });
        
        pricingResult = bundleResults.products[0];
      } else {
        // For individual products, use calculateProductPricing
        pricingResult = await PricingEngine.calculateProductPricing(
          product.ProductId,
          {
            age: getMemberAgeForPricing(member.DateOfBirth, 35),
            tobaccoUse: tobaccoToUse,
            tier: tierToUse
          },
          { configValue1: configValue },
          effectiveDate || null // Pass effective date to select correct pricing tiers based on date
        );
      }
      
      console.log('🔍 DEBUG: PricingEngine result:', {
        productId: product.ProductId,
        success: pricingResult.success,
        monthlyPremium: pricingResult.monthlyPremium,
        error: pricingResult.error
      });
      
      if (pricingResult && pricingResult.monthlyPremium !== undefined) {
        // Store the FULL premium (before employer contributions) for validation
        // This matches what the frontend sends
        const fullPremium = pricingResult.monthlyPremium;
        
        console.log('🔍 DEBUG: Pricing breakdown:', {
          productName: product.Name,
          fullPremium: fullPremium,
          hasGroupContributions: !!member.GroupId
        });
        
        // Calculate contributions for logging/verification (but don't use for validation)
        if (member.GroupId) {
          console.log('🔍 DEBUG: Member is in group, calculating contributions for logging...');
          const contributionResult = await ContributionCalculator.calculateContributions({
            groupId: member.GroupId,
            productPricingResults: [{
              productId: product.ProductId,
              productName: product.Name,
              monthlyPremium: pricingResult.monthlyPremium,
              productType: product.ProductType,
              isBundle: product.ProductType === 'Bundle'
            }],
            memberCriteria: {
              age: getMemberAgeForPricing(member.DateOfBirth, 35),
              tobaccoUse: tobaccoToUse,
              tier: tierToUse
            }
          });
          console.log('🔍 DEBUG: Contribution calculation:', {
            employerTotal: contributionResult.employerTotal,
            employeeTotal: contributionResult.employeeTotal,
            totalPremium: fullPremium
          });
        }
        
        // Use FULL premium for validation (before contributions)
        const pricingItem = {
          productId: product.ProductId,
          productName: product.Name,
          monthlyPremium: fullPremium,  // BEFORE contributions
          configValue: configValue
        };
        
        console.log('🔍 DEBUG: Adding to backendPricing:', pricingItem);
        backendPricing.push(pricingItem);
      } else {
        console.log('🔍 DEBUG: Pricing calculation failed for product:', product.ProductId);
      }
    }
    
    console.log('🔍 DEBUG: Final backendPricing array:', backendPricing);
    return backendPricing;
  } catch (error) {
    console.error('❌ Error calculating backend pricing:', error);
    throw error;
  }
}

// Helper function to validate pricing match between frontend and backend
function validatePricingMatch(frontendPricing, backendPricing) {
  const errors = [];
  const tolerance = 0.01; // Allow 1 cent tolerance for rounding differences
  
  // Create maps for easier comparison
  const frontendMap = new Map();
  frontendPricing.forEach(item => {
    frontendMap.set(item.productId, item);
  });
  
  const backendMap = new Map();
  backendPricing.forEach(item => {
    backendMap.set(item.productId, item);
  });
  
  console.log('🔍 DEBUG: Frontend map:', Array.from(frontendMap.entries()));
  console.log('🔍 DEBUG: Backend map:', Array.from(backendMap.entries()));
  
  // Check all frontend products have backend equivalents
  for (const [productId, frontendItem] of frontendMap) {
    if (!backendMap.has(productId)) {
      console.log('🔍 DEBUG: Product not found in backend:', productId);
      errors.push(`Product ${productId} not found in backend calculation`);
      continue;
    }
    
    const backendItem = backendMap.get(productId);
    const frontendAmount = parseFloat(frontendItem.monthlyPremium || 0);
    const backendAmount = parseFloat(backendItem.monthlyPremium || 0);
    const difference = Math.abs(frontendAmount - backendAmount);
    
    if (difference > tolerance) {
      errors.push(`Product ${productId} (${frontendItem.productName}): Frontend amount $${frontendAmount} does not match backend amount $${backendAmount} (difference: $${difference.toFixed(2)})`);
    }
  }
  
  // Check all backend products have frontend equivalents
  for (const [productId, backendItem] of backendMap) {
    if (!frontendMap.has(productId)) {
      errors.push(`Product ${productId} found in backend but not in frontend`);
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors: errors
  };
}

module.exports = router;
