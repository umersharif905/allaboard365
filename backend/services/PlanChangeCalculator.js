/**
 * Plan Change Calculator Service
 * 
 * Unified calculation logic for plan changes to ensure frontend and backend
 * always calculate the same "Due Today" and "New Monthly Premium" amounts.
 * 
 * This service is used by:
 * - /api/me/member/calculate-plan-change-cost (preview calculation)
 * - /api/me/member/product-changes-complete (actual processing)
 */

const { getPool, sql } = require('../config/database');
const PricingEngine = require('./pricing/PricingEngine');

class PlanChangeCalculator {
  /**
   * Calculate charges for a plan change
   * 
   * @param {Object} params - Calculation parameters
   * @param {string} params.memberId - Member ID
   * @param {Array} params.selectedProducts - Product IDs being selected
   * @param {Array} params.removedProducts - Product IDs being removed
   * @param {Array} params.frontendPricing - Frontend-calculated pricing for validation
   * @param {Object} params.configValues - Configuration values for products
   * @param {Object} params.initialConfigValues - Original configuration values before changes
   * @param {Array} params.dependentsToAdd - Dependents being added
   * @param {string} params.newTobaccoUse - New tobacco status (if changed)
   * @param {string} params.calculatedTier - New tier (if changed)
   * @param {boolean} params.isGroupMember - Whether member is part of a group
   * @param {Object} params.transaction - Database transaction (optional)
   * 
   * @returns {Object} Calculation result
   */
  static async calculatePlanChangeCost(params) {
    const {
      memberId,
      householdId,
      selectedProducts,
      removedProducts = [],
      frontendPricing,
      configValues = {},
      initialConfigValues = {},
      dependentsToAdd = [],
      newTobaccoUse = null,
      calculatedTier = null,
      isGroupMember = false,
      transaction = null
    } = params;

    const pool = transaction || await getPool();
    
    try {
      console.log('🔍 PlanChangeCalculator: Starting calculation...', {
        memberId,
        selectedProductsCount: selectedProducts.length,
        removedProductsCount: removedProducts.length,
        hasTierChange: !!calculatedTier,
        hasTobaccoChange: !!newTobaccoUse,
        dependentsToAddCount: dependentsToAdd.length,
        isGroupMember
      });

      // 1. Get member data
      const memberQuery = `
        SELECT 
          m.MemberId,
          m.UserId,
          m.GroupId,
          m.Tier,
          m.TobaccoUse,
          m.DateOfBirth,
          m.HouseholdId
        FROM oe.Members m
        WHERE m.MemberId = @memberId AND m.Status = 'Active'
      `;
      
      const memberRequest = transaction ? transaction.request() : pool.request();
      const memberResult = await memberRequest
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(memberQuery);
      
      if (memberResult.recordset.length === 0) {
        throw new Error('Member not found');
      }
      
      const member = memberResult.recordset[0];

      // 2. Check for future enrollments
      const futureEnrollmentsQuery = `
        SELECT 
          e.EnrollmentId,
          e.ProductId,
          e.ProductBundleID,
          e.EffectiveDate,
          e.PremiumAmount,
          e.Status
        FROM oe.Enrollments e
        WHERE e.MemberId = @memberId
          AND e.Status = 'Active'
          AND e.EffectiveDate > GETDATE()
      `;
      
      const futureEnrollmentsRequest = transaction ? transaction.request() : pool.request();
      const futureEnrollmentsResult = await futureEnrollmentsRequest
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(futureEnrollmentsQuery);
      
      const futureEnrollments = futureEnrollmentsResult.recordset;
      const hasFutureEnrollments = futureEnrollments.length > 0;

      // 3. Check if future enrollments are already paid
      let futureEnrollmentsAlreadyPaid = false;
      
      if (hasFutureEnrollments) {
        // NOTE: oe.Payments uses HouseholdId, not MemberId!
        const recurringPaymentQuery = `
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
        
        const recurringPaymentRequest = transaction ? transaction.request() : pool.request();
        const recurringPaymentResult = await recurringPaymentRequest
          .input('householdId', sql.UniqueIdentifier, member.HouseholdId)
          .query(recurringPaymentQuery);
        
        if (recurringPaymentResult.recordset.length > 0) {
          const payment = recurringPaymentResult.recordset[0];
          
          console.log('💰 Found payment record:', {
            status: payment.Status,
            amount: payment.Amount,
            hasRecurringSchedule: !!payment.RecurringScheduleId,
            nextBillingDate: payment.NextBillingDate
          });
          
          // Check if recurring schedule exists AND next billing date exists
          if (payment.RecurringScheduleId && payment.NextBillingDate) {
            const nextBillingDate = new Date(payment.NextBillingDate);
            const futureEffectiveDate = new Date(futureEnrollments[0].EffectiveDate);
            
            // If next billing is AFTER effective date, first month is already paid
            futureEnrollmentsAlreadyPaid = nextBillingDate > futureEffectiveDate;
          } else {
            // Payment exists but no recurring schedule - first month IS paid, recurring not set up yet
            // This happens when EnrollmentWizard completes but fails to set up recurring
            console.log('⚠️ Payment exists but no recurring schedule - treating as PAID (will need recurring setup)');
            futureEnrollmentsAlreadyPaid = true;
          }
        } else {
          console.log('⚠️ No payment found for household');
        }
        
        console.log('💰 Future enrollment payment status:', {
          hasFutureEnrollments,
          futureEnrollmentsAlreadyPaid
        });
      }

      // 4. Calculate removed products premium (use actual enrollment PremiumAmount, not recalculated)
      const removedProductsSet = new Set(removedProducts);
      let removedProductsPremiumTotal = 0;
      if (removedProducts.length > 0) {
        // Get premiums from both active and future enrollments for removed products
        // This uses the ACTUAL PremiumAmount from enrollments, not recalculated pricing
        
        // Get active enrollments for removed products - use a simpler query approach
        const removedProductPremiums = new Map();
        
        // Get CURRENT active enrollments only (EffectiveDate <= today) to avoid double-counting with future enrollments
        // CRITICAL: Only count enrollments that are currently active (not future effective)
        const currentActiveEnrollmentsQuery = `
          SELECT 
            e.ProductId,
            e.ProductBundleID,
            e.PremiumAmount,
            e.Status,
            e.EnrollmentType,
            e.EffectiveDate
          FROM oe.Enrollments e
          WHERE e.MemberId = @memberId
            AND e.Status IN ('Active', 'Pending')
            AND e.EffectiveDate <= GETDATE()
            AND (e.TerminationDate IS NULL OR e.TerminationDate > GETDATE())
            AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL OR e.EnrollmentType = 'Bundle')
        `;
        
        const currentActiveRequest = transaction ? transaction.request() : pool.request();
        currentActiveRequest.input('memberId', sql.UniqueIdentifier, memberId);
        const currentActiveResult = await currentActiveRequest.query(currentActiveEnrollmentsQuery);
        
        // Track whether we found a bundle record vs component enrollments
        const bundleRecordFound = new Set(); // Track bundles where we found ProductId = ProductBundleID record
        
        // Process CURRENT active enrollments first (EffectiveDate <= today)
        for (const enrollment of currentActiveResult.recordset) {
          const bundleId = enrollment.ProductBundleID;
          const productId = enrollment.ProductId;
          const premium = enrollment.PremiumAmount || 0;
          
          if (bundleId && removedProductsSet.has(bundleId)) {
            if (productId === bundleId) {
              // Bundle enrollment record (ProductId = ProductBundleID) - use this total premium
              removedProductPremiums.set(bundleId, premium);
              bundleRecordFound.add(bundleId);
            } else if (!bundleRecordFound.has(bundleId)) {
              // Component enrollment - sum components if no bundle record found yet
              const current = removedProductPremiums.get(bundleId) || 0;
              removedProductPremiums.set(bundleId, current + premium);
            }
          } else if (productId && !bundleId && removedProductsSet.has(productId)) {
            // Individual product (not part of a bundle)
            const current = removedProductPremiums.get(productId) || 0;
            removedProductPremiums.set(productId, current + premium);
          }
        }
        
        // Process future enrollments ONLY for products not found in current active enrollments
        // This handles cases where a product is only enrolled in the future (not yet active)
        for (const enrollment of futureEnrollments) {
          const bundleId = enrollment.ProductBundleID;
          const productId = enrollment.ProductId;
          const premium = enrollment.PremiumAmount || 0;
          
          if (bundleId && removedProductsSet.has(bundleId)) {
            // Only process if we didn't already find this bundle in current active enrollments
            // Check bundleRecordFound, not removedProductPremiums.has(), because once we start
            // summing components, removedProductPremiums will have the bundleId but we still need
            // to process all remaining components
            if (!bundleRecordFound.has(bundleId)) {
              // Bundle not found in current active enrollments - process all future enrollments
              if (productId === bundleId) {
                // Bundle enrollment record - use this and mark as found
                removedProductPremiums.set(bundleId, premium);
                bundleRecordFound.add(bundleId);
              } else {
                // Component enrollment - sum all components (will process all components in future enrollments)
                const current = removedProductPremiums.get(bundleId) || 0;
                removedProductPremiums.set(bundleId, current + premium);
              }
            }
            // If bundle already found in current active enrollments, skip future enrollments (no double-counting)
          } else if (productId && !bundleId && removedProductsSet.has(productId)) {
            // Individual product (not part of a bundle) - only add if not found in current active enrollments
            if (!removedProductPremiums.has(productId)) {
              removedProductPremiums.set(productId, premium);
            }
          }
        }
        
        removedProductsPremiumTotal = Array.from(removedProductPremiums.values())
          .reduce((sum, premium) => sum + premium, 0);
        
        // Debug: Log all enrollments found for removed products
        const debugEnrollments = [];
        for (const enrollment of currentActiveResult.recordset) {
          const bundleId = enrollment.ProductBundleID;
          const productId = enrollment.ProductId;
          if ((bundleId && removedProductsSet.has(bundleId)) || (productId && !bundleId && removedProductsSet.has(productId))) {
            debugEnrollments.push({
              source: 'active',
              productId: productId?.substring(0, 8) || 'N/A',
              bundleId: bundleId?.substring(0, 8) || 'N/A',
              premium: enrollment.PremiumAmount || 0,
              isBundleRecord: productId === bundleId
            });
          }
        }
        for (const enrollment of futureEnrollments) {
          const bundleId = enrollment.ProductBundleID;
          const productId = enrollment.ProductId;
          if ((bundleId && removedProductsSet.has(bundleId)) || (productId && !bundleId && removedProductsSet.has(productId))) {
            debugEnrollments.push({
              source: 'future',
              productId: productId?.substring(0, 8) || 'N/A',
              bundleId: bundleId?.substring(0, 8) || 'N/A',
              premium: enrollment.PremiumAmount || 0,
              isBundleRecord: productId === bundleId
            });
          }
        }
        
        console.log('🔍 [Calculator] Removed products premium:', {
          removedProductIds: removedProducts.map(id => id.substring(0, 8)),
          removedProductsPremiumTotal,
          productPremiums: Array.from(removedProductPremiums.entries()).map(([id, premium]) => ({
            productId: id.substring(0, 8),
            premium
          })),
          foundEnrollments: debugEnrollments,
          bundleRecordsFound: Array.from(bundleRecordFound).map(id => id.substring(0, 8))
        });
      }

      // 5. Calculate tier/tobacco repricing (if applicable)
      // NOTE: Exclude removed products from repricing
      let tierTobaccoPremiumAdjustment = 0;
      let repricedFuturePremiumTotal = 0;
      const hasTierOrTobaccoChange = (newTobaccoUse !== null || calculatedTier !== null);
      
      if (hasTierOrTobaccoChange && hasFutureEnrollments) {
        // Calculate old premium (EXCLUDE removed products)
        const oldTotalPremium = futureEnrollments
          .filter(e => {
            const productId = e.ProductBundleID || e.ProductId;
            return !removedProductsSet.has(productId);
          })
          .reduce((sum, e) => sum + (e.PremiumAmount || 0), 0);
        
        // Get household size (including new dependents)
        const householdSizeQuery = `
          SELECT COUNT(*) as HouseholdSize
          FROM oe.Members
          WHERE HouseholdId = @householdId
            AND Status IN ('Active', 'Pending')
        `;
        
        const householdSizeRequest = transaction ? transaction.request() : pool.request();
        const householdSizeResult = await householdSizeRequest
          .input('householdId', sql.UniqueIdentifier, member.HouseholdId)
          .query(householdSizeQuery);
        
        const householdSize = (householdSizeResult.recordset[0]?.HouseholdSize || 1) + dependentsToAdd.length;
        const memberAge = Math.floor((new Date() - new Date(member.DateOfBirth)) / (365.25 * 24 * 60 * 60 * 1000));
        
        const tierForRepricing = calculatedTier || member.Tier;
        const tobaccoForRepricing = newTobaccoUse || (member.TobaccoUse === 'Y' ? 'Yes' : 'No');
        
        // Get unique products from future enrollments (EXCLUDE removed products)
        const uniqueProductsMap = new Map();
        for (const enrollment of futureEnrollments) {
          const productId = enrollment.ProductBundleID || enrollment.ProductId;
          if (!removedProductsSet.has(productId) && !uniqueProductsMap.has(productId)) {
            uniqueProductsMap.set(productId, {
              productId: productId,
              currentPremium: enrollment.PremiumAmount,
              isBundle: !!enrollment.ProductBundleID
            });
          }
        }
        
        // Reprice each unique product (excluding removed products)
        let newTotalPremium = 0;
        for (const [productId, productInfo] of uniqueProductsMap) {
          // CRITICAL: Use OLD config values for tier/tobacco repricing
          // This isolates tier/tobacco changes from config changes
          // Config changes are calculated separately in step 7
          let configValue = 'Default';
          for (const key in initialConfigValues) {
            if (key.includes(productId)) {
              configValue = initialConfigValues[key];
              break;
            }
          }
          
          console.log(`🔍 [Calculator] Repricing ${productId.substring(0, 8)} with OLD config:`, configValue);
          
          // Use PricingEngine to reprice with OLD config
          // CRITICAL: Pass memberId to enable tier recalculation from household composition
          const repricingResult = await PricingEngine.calculatePricing({
            calculationType: 'enrollment',
            memberId: memberId, // Pass memberId to enable tier recalculation
            productSelections: [{
              productId: productId,
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
          
          const monthlyPremium = repricingResult.totals?.totalPremium || 0;
          newTotalPremium += monthlyPremium;
          
          console.log(`🔍 [Calculator] Repriced premium for ${productId.substring(0, 8)}:`, monthlyPremium);
        }
        
        repricedFuturePremiumTotal = newTotalPremium;
        const premiumDifference = newTotalPremium - oldTotalPremium;
        
        console.log('💵 Tier/tobacco repricing:', {
          oldTotalPremium,
          newTotalPremium,
          premiumDifference,
          excludedRemovedProducts: removedProducts.length
        });
        
        // Only charge adjustment if future enrollments are paid AND it's an increase AND not a group member
        if (premiumDifference > 0 && futureEnrollmentsAlreadyPaid && !isGroupMember) {
          tierTobaccoPremiumAdjustment = premiumDifference;
        }
      }

      // 6. Detect configuration changes
      // Compare current config values with initial (enrolled) config values
      const configChanges = [];
      const futureEnrolledProductIds = new Set(
        futureEnrollments.map(e => e.ProductBundleID || e.ProductId).filter(Boolean)
      );
      
      for (const [configKey, newValue] of Object.entries(configValues)) {
        const oldValue = initialConfigValues[configKey];
        
        // Skip if no change
        if (newValue === oldValue) continue;
        
        // Skip if config key is for a removed product
        if (removedProducts.includes(configKey)) continue;
        
        // Check if this is a bundle sub-product config key (format: {bundleId}-{subProductId})
        const isBundleConfig = configKey.includes('-') && configKey.split('-').length > 2;
        
        if (isBundleConfig) {
          // Extract bundle ID from key (first 36 chars = GUID)
          const bundleId = configKey.substring(0, 36);
          
          // Check if this bundle is enrolled in future
          if (futureEnrolledProductIds.has(bundleId) && !removedProducts.includes(bundleId)) {
            console.log(`🔍 [Calculator] Bundle sub-product config change detected:`, {
              bundleId: bundleId.substring(0, 8),
              configKey: configKey.substring(0, 50),
              oldValue,
              newValue
            });
            
            // Add the BUNDLE for config change tracking
            if (!configChanges.some(([pid]) => pid === bundleId)) {
              configChanges.push([bundleId, newValue]);
            }
          }
        } else {
          // Regular product config change
          if (futureEnrolledProductIds.has(configKey) && !removedProducts.includes(configKey)) {
            console.log(`🔍 [Calculator] Product config change detected:`, {
              productId: configKey.substring(0, 8),
              oldValue,
              newValue
            });
            configChanges.push([configKey, newValue]);
          }
        }
      }
      
      console.log(`🔍 [Calculator] Configuration changes detected:`, 
        configChanges.map(([pid, val]) => ({ productId: pid.substring(0, 8), value: val })));
      
      // 7. Calculate charge for NEW products
      const configChangeProductIds = configChanges.map(([pid]) => pid);
      const newProductIds = selectedProducts.filter(pid => 
        !futureEnrolledProductIds.has(pid) &&
        !configChangeProductIds.includes(pid)
      );
      
      let newProductsCharge = 0;
      if (newProductIds.length > 0 && frontendPricing) {
        newProductsCharge = frontendPricing
          .filter(p => newProductIds.includes(p.productId))
          .reduce((sum, p) => sum + (p.monthlyPremium || 0), 0);
      }
      
      console.log('🔍 [Calculator] New products charge:', {
        newProductIds: newProductIds.map(id => id.substring(0, 8)),
        newProductsCharge
      });

      // 8. Calculate configuration change adjustments (if future enrollments are paid)
      let configChangeAdjustment = 0;
      
      if (configChanges.length > 0 && hasFutureEnrollments && futureEnrollmentsAlreadyPaid && !isGroupMember) {
        console.log('💡 [Calculator] Future enrollments already paid - calculating config change adjustment...');
        
        // Get old premiums from enrollments
        const configChangeOldTotal = futureEnrollments
          .filter(e => configChangeProductIds.includes(e.ProductBundleID || e.ProductId))
          .reduce((sum, e) => sum + (e.PremiumAmount || 0), 0);
        
        // Get new premiums from frontend
        const configChangeNewTotal = frontendPricing
          ?.filter(p => configChangeProductIds.includes(p.productId))
          .reduce((sum, p) => sum + (p.monthlyPremium || 0), 0) || 0;
        
        configChangeAdjustment = configChangeNewTotal - configChangeOldTotal;
        
        console.log('💰 [Calculator] Config change adjustment:', {
          configChangeProductIds: configChangeProductIds.map(id => id.substring(0, 8)),
          oldTotal: configChangeOldTotal,
          newTotal: configChangeNewTotal,
          adjustment: configChangeAdjustment
        });
      }

      // 9. Calculate final charge amount
      let chargeAmount = 0;
      let processingFee = 0;
      let reason = '';
      
      if (isGroupMember) {
        chargeAmount = 0;
        reason = 'Employer covers all costs';
      } else if (!hasFutureEnrollments) {
        // No future enrollments - charge full first month
        const fullMonthlyTotal = frontendPricing?.reduce((sum, p) => sum + (p.monthlyPremium || 0), 0) || 0;
        chargeAmount = fullMonthlyTotal;
        reason = 'First month payment for new plan';
      } else if (futureEnrollmentsAlreadyPaid) {
        // Future enrollments already paid - charge for new products + adjustments
        // The existing products' first month is already paid, so we need to collect for additions NOW
        chargeAmount = newProductsCharge + tierTobaccoPremiumAdjustment + configChangeAdjustment;
        
        // Can't have negative charge (would be a credit)
        if (chargeAmount < 0) {
          console.log(`💳 [Calculator] Negative charge ($${chargeAmount}) converted to $0 (credit)`);
          chargeAmount = 0;
        }
        
        const reasons = [];
        if (newProductsCharge > 0) reasons.push(`${newProductIds.length} new product${newProductIds.length > 1 ? 's' : ''}`);
        if (tierTobaccoPremiumAdjustment > 0) reasons.push('tier/tobacco adjustment');
        if (configChangeAdjustment > 0) reasons.push(`config upgrade (+$${configChangeAdjustment})`);
        if (configChangeAdjustment < 0) reasons.push(`config savings ($${configChangeAdjustment})`);
        
        reason = reasons.length > 0 
          ? `First month payment for ${reasons.join(' + ')}`
          : 'No additional charge needed';
      } else {
        // Future enrollments NOT paid yet - recurring payment will handle everything
        // Don't charge for new products upfront - they'll be included in the first recurring payment
        // This ensures all products (existing + new) are charged together when the plan goes live
        chargeAmount = 0;
        reason = 'No charge - recurring payment will include all products on effective date';
        
        console.log('💡 [Calculator] Future enrollments not paid yet - $0 due today (recurring will handle all products together)');
      }
      
      // Calculate processing fee if there's a charge and member pays fees
      if (chargeAmount > 0 && !isGroupMember) {
        // Get tenant's payment processor settings
        const tenantQuery = `SELECT PaymentProcessorSettings FROM oe.Tenants WHERE TenantId = @tenantId`;
        const tenantRequest = transaction ? transaction.request() : pool.request();
        const tenantResult = await tenantRequest
          .input('tenantId', sql.UniqueIdentifier, memberResult.TenantId)
          .query(tenantQuery);
        
        let paymentProcessorSettings = null;
        if (tenantResult.recordset.length > 0 && tenantResult.recordset[0].PaymentProcessorSettings) {
          try {
            paymentProcessorSettings = JSON.parse(tenantResult.recordset[0].PaymentProcessorSettings);
          } catch (e) {
            console.warn('⚠️ Failed to parse PaymentProcessorSettings:', e);
          }
        }
        
        // Calculate processing fee (payment method will be determined at payment time).
        // This is intentionally a CONSERVATIVE estimate using 'Card' - the actual fee is computed at
        // payment time by product-changes-complete.js, which is ZeroFeeForACH-aware. Keeping the
        // estimate at Card rate means a member may see a slightly higher preview here than the actual
        // charge; the real charge is always correct. Not fixing per-product here because chargeAmount
        // is derived as a scalar (new-product + tier-tobacco + config-change) and we don't have a
        // clean per-product breakdown of that composite.
        const processingFeeCalculator = require('../utils/processingFeeCalculator');
        processingFee = processingFeeCalculator.calculateProcessingFee(
          chargeAmount,
          'Card', // Conservative estimate - payment-time calc honors ZeroFeeForACH per product
          paymentProcessorSettings
        );
        
        console.log(`💳 [Calculator] Processing fee calculated: $${processingFee.toFixed(2)}`);
      }

      // 10. Calculate new monthly total
      const currentEnrollmentTotalQuery = `
        SELECT SUM(PremiumAmount) as CurrentTotal
        FROM oe.Enrollments
        WHERE MemberId = @memberId 
          AND Status = 'Active'
          AND (TerminationDate IS NULL OR TerminationDate > GETDATE())
      `;
      
      const currentEnrollmentTotalRequest = transaction ? transaction.request() : pool.request();
      const currentEnrollmentTotalResult = await currentEnrollmentTotalRequest
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(currentEnrollmentTotalQuery);
      
      const currentEnrollmentTotal = currentEnrollmentTotalResult.recordset[0]?.CurrentTotal || 0;
      
      // Calculate old config prices (will be subtracted)
      let configChangeOldPremiumTotal = 0;
      if (configChanges.length > 0) {
        configChangeOldPremiumTotal = futureEnrollments
          .filter(e => configChangeProductIds.includes(e.ProductBundleID || e.ProductId))
          .reduce((sum, e) => sum + (e.PremiumAmount || 0), 0);
      }
      
      // Calculate new config prices (will be added)
      const configChangeNewPremiumTotal = configChanges.length > 0
        ? frontendPricing
            ?.filter(p => configChangeProductIds.includes(p.productId))
            .reduce((sum, p) => sum + (p.monthlyPremium || 0), 0) || 0
        : 0;
      
      // Calculate new monthly total
      // CRITICAL: Must subtract removed products premium using ACTUAL enrollment PremiumAmount
      let newMonthlyTotal = 0;
      if (repricedFuturePremiumTotal > 0) {
        // Tier/tobacco changed - repriced total already excludes removed products from repricing calculation
        // However, we still need to account for the removed products that were in currentEnrollmentTotal
        // The repriced total is the NEW price for products that remain (excluding removed products)
        // So: (currentTotal - removedProducts) gets repriced to repricedFuturePremiumTotal
        // Then add new products
        newMonthlyTotal = repricedFuturePremiumTotal + newProductsCharge;
        
        console.log('🔍 [Calculator] Monthly total breakdown (tier/tobacco repricing):', {
          currentEnrollmentTotal,
          removedProductsPremiumTotal,
          remainingAfterRemoval: currentEnrollmentTotal - removedProductsPremiumTotal,
          repricedFuturePremiumTotal,
          newProductsCharge,
          newMonthlyTotal,
          calculation: `(Current: ${currentEnrollmentTotal} - Removed: ${removedProductsPremiumTotal}) repriced to ${repricedFuturePremiumTotal} + New: ${newProductsCharge} = ${newMonthlyTotal}`
        });
      } else {
        // Normal calculation: current - old config + new config + new products - removed products
        const newProductsTotal = frontendPricing
          ?.filter(p => newProductIds.includes(p.productId))
          .reduce((sum, p) => sum + (p.monthlyPremium || 0), 0) || 0;
        
        newMonthlyTotal = currentEnrollmentTotal 
                        - configChangeOldPremiumTotal 
                        + configChangeNewPremiumTotal 
                        + newProductsTotal
                        - removedProductsPremiumTotal;
        
        console.log('🔍 [Calculator] Monthly total breakdown:', {
          currentEnrollmentTotal,
          configChangeOldPremiumTotal,
          configChangeNewPremiumTotal,
          newProductsTotal,
          removedProductsPremiumTotal,
          newMonthlyTotal,
          calculation: `${currentEnrollmentTotal} - ${configChangeOldPremiumTotal} + ${configChangeNewPremiumTotal} + ${newProductsTotal} - ${removedProductsPremiumTotal} = ${newMonthlyTotal}`
        });
      }
      
      // Ensure newMonthlyTotal doesn't go negative
      if (newMonthlyTotal < 0) {
        console.log(`⚠️ [Calculator] New monthly total is negative ($${newMonthlyTotal}), setting to 0`);
        newMonthlyTotal = 0;
      }

      // 11. Return calculation result
      const result = {
        dueToday: chargeAmount,
        processingFee: processingFee,
        totalDueToday: chargeAmount + processingFee,
        newMonthlyTotal: newMonthlyTotal,
        breakdown: {
          tierTobaccoAdjustment: tierTobaccoPremiumAdjustment,
          newProducts: newProductsCharge,
          configChangeAdjustment: configChangeAdjustment,
          configChangeCount: configChanges.length,
          removedProducts: -removedProductsPremiumTotal, // Negative value to indicate removal
          currentEnrollmentTotal: currentEnrollmentTotal,
          repricedFutureTotal: repricedFuturePremiumTotal
        },
        explanation: reason,
        paymentStatus: {
          hasFutureEnrollments,
          futureEnrollmentsAlreadyPaid,
          isGroupMember
        }
      };

      console.log('✅ PlanChangeCalculator: Calculation complete', result);
      return result;
      
    } catch (error) {
      console.error('❌ PlanChangeCalculator error:', error);
      throw error;
    }
  }
}

module.exports = PlanChangeCalculator;

