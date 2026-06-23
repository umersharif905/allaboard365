/**
 * Calculate Plan Change Cost Endpoint
 * 
 * Preview endpoint that calculates exact charges for plan changes
 * WITHOUT actually processing the change. Frontend uses this to show
 * accurate "Due Today" and "New Monthly Premium" on confirmation page.
 * 
 * The actual processing endpoint (product-changes-complete) uses the
 * SAME PlanChangeCalculator service to ensure amounts match.
 */

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const PlanChangeCalculator = require('../../../services/PlanChangeCalculator');
const ContributionCalculator = require('../../../services/pricing/ContributionCalculator');
const PricingEngine = require('../../../services/pricing/PricingEngine');
const { getEffectiveMemberId } = require('../../../middleware/attachMemberHouseholdContext');

// Note: Auth middleware is applied by parent router (/me/member/index.js)
router.post('/', async (req, res) => {
  try {
    console.log('🔍 Calculate plan change cost request');
    console.log('🔍 Request body:', JSON.stringify(req.body, null, 2));
    
    const {
      selectedProducts,
      removedProducts = [],
      frontendPricing,
      configValues = {},
      initialConfigValues = {},
      dependentsToAdd = [],
      dependentsToRemove = [],
      newTobaccoUse = null,
      calculatedTier = null,
      memberId: requestMemberId = null, // Optional: for admin users managing on behalf of another member
      effectiveDate = null // Effective date for pricing (YYYY-MM-DD format) - used to select correct pricing tiers
    } = req.body;
    
    // Log memberId parameter for debugging
    console.log('🔍 Request memberId parameter:', {
      hasRequestMemberId: !!requestMemberId,
      requestMemberId: requestMemberId,
      userEmail: req.user?.Email,
      currentRole: req.user?.currentRole
    });

    console.log('🔍 Extracted parameters:', {
      hasSelectedProducts: !!selectedProducts,
      selectedProductsType: typeof selectedProducts,
      hasRemovedProducts: !!removedProducts,
      hasFrontendPricing: !!frontendPricing,
      hasConfigValues: !!configValues,
      hasRequestMemberId: !!requestMemberId
    });

    // Get member - use provided memberId for admin users, otherwise use authenticated user
    console.log('🔍 About to get database pool...');
    const pool = await getPool();
    console.log('✅ Got database pool');
    console.log('🔍 req.user data:', {
      hasUser: !!req.user,
      Email: req.user?.Email, // PascalCase!
      userId: req.user?.UserId,
      currentRole: req.user?.currentRole
    });
    
    let memberQuery;
    let memberRequest = pool.request();
    
    if (requestMemberId) {
      // Admin user managing on behalf of another member
      console.log('🔍 Admin user managing for member:', requestMemberId);
      memberQuery = `
        SELECT 
          m.MemberId, 
          m.GroupId, 
          m.HouseholdId,
          m.Tier,
          m.DateOfBirth,
          m.TobaccoUse,
          m.JobPosition
        FROM oe.Members m
        WHERE m.MemberId = @memberId AND m.Status = 'Active'
      `;
      memberRequest.input('memberId', sql.UniqueIdentifier, requestMemberId);
    } else {
      const effectiveMemberId = getEffectiveMemberId(req);
      memberQuery = `
        SELECT 
          m.MemberId, 
          m.GroupId, 
          m.HouseholdId,
          m.Tier,
          m.DateOfBirth,
          m.TobaccoUse,
          m.JobPosition
        FROM oe.Members m
        WHERE m.MemberId = @memberId AND m.Status = 'Active'
      `;
      memberRequest.input('memberId', sql.UniqueIdentifier, effectiveMemberId);
    }
    
    console.log('🔍 About to execute member query...');
    const memberResult = await memberRequest.query(memberQuery);
    
    console.log('🔍 Member query executed:', {
      recordCount: memberResult.recordset.length,
      Email: req.user.Email
    });
    
    if (memberResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Member not found'
      });
    }
    
    const member = memberResult.recordset[0];
    const isGroupMember = !!member.GroupId;
    
    console.log('🔍 Member info for calculation:', {
      memberId: member.MemberId,
      householdId: member.HouseholdId,
      isGroupMember
    });

    console.log('🔍 Request body data:', {
      selectedProductsCount: selectedProducts?.length || 0,
      removedProductsCount: removedProducts?.length || 0,
      frontendPricingCount: frontendPricing?.length || 0,
      hasConfigValues: !!configValues,
      dependentsToAddCount: dependentsToAdd?.length || 0,
      hasNewTobaccoUse: !!newTobaccoUse,
      hasCalculatedTier: !!calculatedTier
    });

    // Calculate using unified service
    console.log('🔍 About to call PlanChangeCalculator.calculatePlanChangeCost...');
    console.log('🔍 Calculator parameters:', {
      memberId: member.MemberId,
      householdId: member.HouseholdId,
      selectedProductsCount: selectedProducts?.length || 0,
      removedProductsCount: removedProducts?.length || 0,
      frontendPricingCount: frontendPricing?.length || 0,
      hasConfigValues: Object.keys(configValues || {}).length > 0,
      dependentsToAddCount: dependentsToAdd?.length || 0,
      hasNewTobaccoUse: !!newTobaccoUse,
      hasCalculatedTier: !!calculatedTier,
      isGroupMember
    });
    
    let calculation;
    try {
      calculation = await PlanChangeCalculator.calculatePlanChangeCost({
        memberId: member.MemberId,
        householdId: member.HouseholdId,
        selectedProducts,
        removedProducts,
        frontendPricing,
        configValues,
        initialConfigValues,
        dependentsToAdd,
        newTobaccoUse,
        calculatedTier,
        isGroupMember
      });
      console.log('✅ Calculator completed successfully');
    } catch (calcError) {
      console.error('❌ PlanChangeCalculator.calculatePlanChangeCost failed:', calcError);
      throw calcError; // Re-throw to be caught by outer try/catch
    }

    // Calculate contributions if group member
    let contributionData = {
      totalEmployerContribution: 0,
      totalEmployeeContribution: 0,
      hasContributions: false
    };

    // Authority output from pricingAuthority.computePricing via planMod.computeNewPlanCost.
    // Phase 5.8: expose this block so the frontend renders fee values from backend authority
    // rather than recomputing them client-side. Remains null if computeNewPlanCost wasn't
    // called (edge case: no products, non-group, or chargeFeeToMember disabled).
    let authorityOutputForResponse = null;

    if (isGroupMember && member.GroupId && calculation.newMonthlyTotal > 0) {
      try {
        console.log('🔍 Calculating contributions for group member...');
        
        // Get member age
        const ageQuery = `SELECT DATEDIFF(YEAR, DateOfBirth, GETDATE()) as Age FROM oe.Members WHERE MemberId = @memberId`;
        const ageResult = await pool.request()
          .input('memberId', sql.UniqueIdentifier, member.MemberId)
          .query(ageQuery);
        const memberAge = ageResult.recordset[0]?.Age || 35;

        // Get household members to calculate tier from PROSPECTIVE household composition
        // This includes dependents being added and excludes dependents being removed
        // This ensures we use the correct tier for the projected household state
        const householdMembersQuery = `
          SELECT 
            MemberId,
            RelationshipType,
            CASE 
              WHEN UserId = @userId THEN 1 
              ELSE 0 
            END as IsCurrentUser
          FROM oe.Members
          WHERE HouseholdId = @householdId
            AND Status = 'Active'
        `;
        const householdMembersResult = await pool.request()
          .input('householdId', sql.UniqueIdentifier, member.HouseholdId)
          .input('userId', sql.UniqueIdentifier, member.UserId)
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
            // Frontend: 'S' = Spouse, 'C' = Child
            // Database: 'S' = Spouse, 'C' = Child (should be same, but verify)
            prospectiveHouseholdMembers.push({
              MemberId: null, // New member, doesn't have ID yet
              RelationshipType: dependent.relationshipType || 'C',
              IsCurrentUser: 0
            });
          }
        }
        
        const TierCalculator = require('../../../services/pricing/TierCalculator');
        const calculatedTierFromHousehold = TierCalculator.calculateTierFromHousehold(prospectiveHouseholdMembers, member.MemberId);
        
        // Determine final tier and tobacco values
        // CRITICAL: Use tier calculated from PROSPECTIVE household composition (including dependents being added)
        const finalTier = calculatedTierFromHousehold;
        const finalTobaccoUse = newTobaccoUse || member.TobaccoUse || 'No';
        
        const householdSize = prospectiveHouseholdMembers.length;
        
        console.log(`🔍 Tier calculation for contributions:`, {
          frontendCalculatedTier: calculatedTier,
          dbTier: member.Tier,
          calculatedTierFromHousehold: calculatedTierFromHousehold,
          householdSize: householdSize,
          usingTier: finalTier,
          currentHouseholdSize: householdMembersResult.recordset.length,
          dependentsToAddCount: dependentsToAdd?.length || 0,
          dependentsToRemoveCount: dependentsToRemove?.length || 0,
          prospectiveHouseholdSize: prospectiveHouseholdMembers.length
        });

        // Build product pricing results from frontendPricing for contribution calculation
        let productPricingResults = (frontendPricing || []).map(p => ({
          productId: p.productId,
          monthlyPremium: p.monthlyPremium || 0,
          productName: p.productName || ''
        })).filter(p => selectedProducts && selectedProducts.includes(p.productId) && !removedProducts.includes(p.productId));

        // If no frontend pricing, we need to calculate pricing
        // This handles both explicit product selections AND household changes (tier changes)
        if (productPricingResults.length === 0) {
          console.log('⚠️ No frontend pricing provided, calculating pricing for contributions...');
          
          // Determine which products to calculate pricing for
          let productsToPrice = [];
          
          if (selectedProducts && selectedProducts.length > 0) {
            // Explicit product selections
            productsToPrice = selectedProducts.filter(pid => !removedProducts.includes(pid));
          } else {
            // Household changes only - get existing active products
            console.log('🔍 Household changes detected, fetching existing products for contribution calculation...');
            const existingProductsQuery = `
              SELECT DISTINCT 
                e.ProductId,
                e.ProductBundleID,
                e.ConfigValue1,
                e.ConfigValue2,
                e.ConfigValue3,
                e.ConfigValue4
              FROM oe.Enrollments e
              WHERE e.MemberId = @memberId
                AND e.Status = 'Active'
                AND e.EffectiveDate <= GETDATE()
                AND e.EnrollmentType IN ('Medical', 'Dental', 'Vision', 'Life', 'Disability', 'Bundle')
            `;
            
            const existingProductsResult = await pool.request()
              .input('memberId', sql.UniqueIdentifier, member.MemberId)
              .query(existingProductsQuery);
            
            // Build product selections from existing enrollments
            for (const enrollment of existingProductsResult.recordset) {
              const productId = enrollment.ProductBundleID || enrollment.ProductId;
              if (productId && !removedProducts.includes(productId)) {
                // Get config values from enrollment or configValues
                const configKey = productId;
                const configValue = configValues[configKey] || enrollment.ConfigValue1 || 'Default';
                
                productsToPrice.push({
                  productId: productId,
                  configValues: { configValue1: configValue }
                });
              }
            }
            
            console.log(`🔍 Found ${productsToPrice.length} existing products to price for contributions`);
          }
          
          if (productsToPrice.length > 0) {
            // Use PricingEngine to get product pricing
            // CRITICAL: Pass memberId to enable tier recalculation from household composition
            const pricingResult = await PricingEngine.calculatePricing({
              calculationType: 'enrollment',
              memberId: member.MemberId, // Pass memberId to enable tier recalculation
              productSelections: productsToPrice.map(p => 
                typeof p === 'string' 
                  ? { productId: p, configValues: configValues[p] ? { configValue1: configValues[p] } : {} }
                  : p
              ),
              memberCriteria: {
                age: memberAge,
                tobaccoUse: finalTobaccoUse,
                tier: finalTier,
                householdSize: householdSize,
                jobPosition: member.JobPosition || null
              },
              groupId: member.GroupId,
              effectiveDate: effectiveDate || null // Pass effective date to select correct pricing tiers based on date
            });

            if (pricingResult.products) {
              productPricingResults = pricingResult.products.map(p => ({
                productId: p.productId,
                monthlyPremium: p.monthlyPremium || 0,
                productName: p.productName || ''
              }));
            }
          }
        }

        if (productPricingResults.length > 0) {
          const totalPremium = productPricingResults.reduce((sum, p) => sum + p.monthlyPremium, 0);
          
          // Calculate fees for MaxEmployee contribution calculation
          // MaxEmployee rules need fees included in the total premium calculation
          let additionalFees = 0;
          try {
            // Get tenant settings for fee calculation
            const tenantQuery = `
              SELECT 
                t.TenantId,
                t.SystemFees,
                t.PaymentProcessorSettings
              FROM oe.Members m
              INNER JOIN oe.Tenants t ON m.TenantId = t.TenantId
              WHERE m.MemberId = @memberId
            `;
            const tenantResult = await pool.request()
              .input('memberId', sql.UniqueIdentifier, member.MemberId)
              .query(tenantQuery);
            
            if (tenantResult.recordset.length > 0) {
              const tenantData = tenantResult.recordset[0];
              
              // Calculate system fees
              if (tenantData.SystemFees) {
                try {
                  const systemFeesSettings = typeof tenantData.SystemFees === 'string' 
                    ? JSON.parse(tenantData.SystemFees) 
                    : tenantData.SystemFees;
                  const systemFeesCalculator = require('../../../utils/systemFeesCalculator');
                  const systemFeesAmount = systemFeesCalculator.calculateSystemFees(totalPremium, systemFeesSettings);
                  additionalFees += systemFeesAmount;
                } catch (e) {
                  console.warn('⚠️ Error calculating system fees for contributions:', e);
                }
              }
              
              // Calculate processing fees (only if chargeFeeToMember is enabled)
              if (tenantData.PaymentProcessorSettings) {
                try {
                  const paymentProcessorSettings = typeof tenantData.PaymentProcessorSettings === 'string'
                    ? JSON.parse(tenantData.PaymentProcessorSettings)
                    : tenantData.PaymentProcessorSettings;
                  
                  if (paymentProcessorSettings?.chargeFeeToMember) {
                    // Get group's payment method for processing fee calculation
                    const groupPaymentMethodQuery = `
                      SELECT TOP 1 Type 
                      FROM oe.GroupPaymentMethods 
                      WHERE GroupId = @groupId AND Status = 'Active' 
                      ORDER BY IsDefault DESC, CreatedDate DESC
                    `;
                    const groupPaymentMethodResult = await pool.request()
                      .input('groupId', sql.UniqueIdentifier, member.GroupId)
                      .query(groupPaymentMethodQuery);
                    
                    const groupPaymentMethod = groupPaymentMethodResult.recordset[0]?.Type === 'CreditCard' ? 'Card' : 'ACH';

                    // Phase 3: fee math via pricingAuthority (single source of truth).
                    // Authority enforces 'Highest' for included fees, member's method for non-included.
                    const planMod = require('../../../services/plan-modifications/planModification.service');
                    const pricingProductsForAuth = (productPricingResults || [])
                      .filter((r) => r?.productId && Number(r?.monthlyPremium || 0) > 0)
                      .map((r) => ({
                        productId: String(r.productId),
                        productName: r.productName || '',
                        monthlyPremium: Number(r.monthlyPremium || 0),
                        isBundle: Boolean(r.isBundle),
                        includedProducts: Array.isArray(r.includedProducts) ? r.includedProducts.map((ip) => ({
                          productId: String(ip.productId || ''),
                          productName: ip.productName || '',
                          monthlyPremium: Number(ip.monthlyPremium || 0)
                        })) : undefined
                      }));
                    if (pricingProductsForAuth.length > 0) {
                      const costDetails = await planMod.computeNewPlanCost({
                        tenantId: tenantData.TenantId,
                        pricingProducts: pricingProductsForAuth,
                        paymentMethodType: groupPaymentMethod,
                        poolOrTransaction: pool
                      });
                      additionalFees += Number(costDetails.totals.includedFeeTotal || 0) + Number(costDetails.totals.nonIncludedFeeTotal || 0);
                      // Phase 5.8: capture authority output for the response body so the frontend
                      // can render fee amounts from backend authority instead of recomputing.
                      authorityOutputForResponse = {
                        products: costDetails.products,
                        totals: costDetails.totals,
                        display: costDetails.display,
                        pricingFingerprint: costDetails.pricingFingerprint
                      };
                    }
                  }
                } catch (e) {
                  console.warn('⚠️ Error calculating processing fees for contributions:', e);
                }
              }
            }
          } catch (feeError) {
            console.warn('⚠️ Error calculating fees for MaxEmployee contribution calculation (non-fatal):', feeError);
            // Continue without fees - contribution calculation will still work, just won't include fees
          }
          
          console.log('🔍 About to calculate contributions with:', {
            groupId: member.GroupId,
            productPricingResults: productPricingResults.map(p => ({
              productId: p.productId.substring(0, 8),
              productName: p.productName,
              monthlyPremium: p.monthlyPremium
            })),
            memberCriteria: {
              age: memberAge,
              tier: finalTier,
              tobaccoUse: finalTobaccoUse,
              jobPosition: member.JobPosition || null,
              householdSize: householdSize
            },
            totalPremium: totalPremium,
            additionalFees: additionalFees
          });
          
          // Calculate contributions using ContributionCalculator
          // Pass additionalFees for MaxEmployee rule calculations (fees included in premium)
          const contributionResults = await ContributionCalculator.calculateContributions({
            groupId: member.GroupId,
            productPricingResults: productPricingResults,
            memberCriteria: {
              age: memberAge,
              tier: finalTier,
              tobaccoUse: finalTobaccoUse,
              jobPosition: member.JobPosition || null,
              householdSize: householdSize
            },
            additionalFees: additionalFees
          });

          console.log('📊 ContributionCalculator result:', {
            employerTotal: contributionResults.employerTotal,
            employeeTotal: contributionResults.employeeTotal,
            appliedRulesCount: contributionResults.appliedRules?.length || 0,
            appliedRules: contributionResults.appliedRules?.map((r) => ({
              name: r.name || r.Name,
              type: r.type || r.ContributionType,
              amount: r.amount || r.FlatRateAmount || r.PercentageAmount,
              tier: finalTier,
              tierContribution: r.tierContribution || 'N/A',
              direction: r.direction || r.ContributionDirection || 'N/A',
              maxEmployeeAmount: r.maxEmployeeAmount || 'N/A'
            })) || [],
            totalPremium: productPricingResults.reduce((sum, p) => sum + p.monthlyPremium, 0),
            calculation: `Premium: $${productPricingResults.reduce((sum, p) => sum + p.monthlyPremium, 0).toFixed(2)} - Employer: $${contributionResults.employerTotal.toFixed(2)} = Employee: $${contributionResults.employeeTotal.toFixed(2)}`
          });

          contributionData = {
            totalEmployerContribution: contributionResults.employerTotal || 0,
            totalEmployeeContribution: contributionResults.employeeTotal || 0,
            hasContributions: (contributionResults.employerTotal || 0) > 0,
            contributionDetails: {
              appliedRules: contributionResults.appliedRules || [],
              productContributions: contributionResults.productContributions || {},
              allProductsContribution: contributionResults.allProductsContribution || 0
            }
          };

          console.log('✅ Contributions calculated:', contributionData);
        } else {
          console.log('⚠️ No product pricing results to calculate contributions for');
        }
      } catch (contribError) {
        console.error('⚠️ Error calculating contributions (non-fatal):', contribError);
        // Don't fail the entire request if contributions fail
      }
    }

    // Catch-all authority computation: if the group/chargeFeeToMember branch above didn't run,
    // still compute authority output for any member with priceable products so the frontend always
    // has a fee breakdown to render. Guards against the ProductChangeWizard showing $0 fees for
    // individual members or chargeFeeToMember-disabled tenants.
    if (!authorityOutputForResponse) {
      try {
        const planMod = require('../../../services/plan-modifications/planModification.service');
        const pricingProductsCatchAll = (frontendPricing || [])
          .map((p) => ({
            productId: String(p?.productId || ''),
            monthlyPremium: Number(p?.monthlyPremium || 0),
            productName: p?.productName || ''
          }))
          .filter((p) => p.productId && p.monthlyPremium > 0);
        if (pricingProductsCatchAll.length > 0 && member?.TenantId) {
          const groupPm = isGroupMember && member.GroupId
            ? await planMod.getPrimaryPaymentMethod({ poolOrTransaction: pool, householdId: member.HouseholdId }).catch(() => null)
            : null;
          const paymentMethodType = (groupPm?.Type === 'CreditCard' ? 'Card' : (groupPm?.Type || 'ACH'));
          const catchAllCost = await planMod.computeNewPlanCost({
            tenantId: member.TenantId,
            pricingProducts: pricingProductsCatchAll,
            paymentMethodType,
            poolOrTransaction: pool
          });
          authorityOutputForResponse = {
            products: catchAllCost.products,
            totals: catchAllCost.totals,
            display: catchAllCost.display,
            pricingFingerprint: catchAllCost.pricingFingerprint
          };
        }
      } catch (authorityFallbackError) {
        console.warn('⚠️ Catch-all authority computation failed (non-fatal):', authorityFallbackError?.message);
      }
    }

    // Combine calculation with contribution data
    const responseData = {
      ...calculation,
      contributions: contributionData,
      authority: authorityOutputForResponse
    };

    return res.json({
      success: true,
      data: responseData
    });
    
  } catch (error) {
    console.error('❌ Error calculating plan change cost:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    
    // Return proper status code based on error type
    const statusCode = error.message === 'Member not found' ? 404 : 500;
    
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to calculate cost',
      message: error.message
    });
  }
});

module.exports = router;

