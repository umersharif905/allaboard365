/**
 * UNIFIED PRICING ENGINE - Main pricing calculation engine
 * 
 * Used by all endpoints:
 * - /api/pricing/calculate (All scenarios)
 * - /api/pricing/current/:memberId (Current member pricing)
 * - /api/me/member/pricing/current (Member's own pricing)
 * - /api/me/agent/pricing/current/:memberId (Agent access)
 * - /api/me/tenant-admin/pricing/current/:memberId (TenantAdmin access)
 */

const { getPool, sql } = require('../../config/database');
const PricingValidator = require('./PricingValidator');
const ContributionCalculator = require('./ContributionCalculator');
const BundleProcessor = require('./BundleProcessor');
const TierCalculator = require('./TierCalculator');
const includedProcessingFeeUtil = require('../../utils/includedProcessingFee');
const productProcessingFeesUtil = require('../../utils/productProcessingFees');

class PricingEngine {
  /**
   * Main unified pricing calculation
   * @param {Object} params - Pricing parameters
   * @param {string} params.memberId - Member ID (optional for new enrollments)
   * @param {string} params.calculationType - 'enrollment' | 'current' | 'simulation'
   * @param {Array} params.productSelections - Selected product IDs with configs
   * @param {Object} params.memberCriteria - Age, tobacco, tier, household info
   * @param {string} params.groupId - Group ID (for contribution rules)
   * @param {Object} params.simulationContext - For simulation scenarios
   * @returns {Object} Complete pricing breakdown
   */
  static async calculatePricing(params) {
    try {
      console.log('🔍 DEBUG: Starting pricing calculation with params:', {
        calculationType: params.calculationType,
        memberId: params.memberId,
        productSelectionsCount: params.productSelections?.length || 0,
        groupId: params.groupId
      });

      // 1. Validate inputs
      PricingValidator.validateInputs(params);
      
      // 2. Prepare product selections based on calculation type
      let productSelections = params.productSelections;
      let memberCriteria = params.memberCriteria;
      let groupId = params.groupId;

      if (params.calculationType === 'current') {
        // Get current enrollments from database
        const currentData = await this.getCurrentMemberData(params.memberId);
        productSelections = currentData.productSelections;
        memberCriteria = currentData.memberCriteria;
        groupId = currentData.groupId;
      } else if (params.calculationType === 'enrollment' && params.memberId) {
        // For enrollment calculations with memberId, recalculate tier from household composition
        // This ensures we use the correct tier even if frontend sends wrong tier
        // NOTE: This uses CURRENT household state. For projected changes (adding dependents),
        // the frontend should send the projected tier, and we trust it.
        // However, if the tier clearly doesn't match current household (e.g., EE but has dependents),
        // we correct it to match current household composition.
        const pool = await getPool();
        const request = pool.request();
        request.input('memberId', sql.UniqueIdentifier, params.memberId);
        
        // Get member and household info
        const memberResult = await request.query(`
          SELECT 
            m.MemberId,
            m.UserId,
            m.HouseholdId,
            m.GroupId
          FROM oe.Members m
          WHERE m.MemberId = @memberId
            AND m.Status = 'Active'
        `);
        
        if (memberResult.recordset.length > 0) {
          const member = memberResult.recordset[0];
          
          // Get household members to calculate tier from CURRENT household state
          request.input('householdId', sql.UniqueIdentifier, member.HouseholdId);
          request.input('userId', sql.UniqueIdentifier, member.UserId);
          
          const householdResult = await request.query(`
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
          `);
          
          const householdMembers = householdResult.recordset;
          const calculatedTierFromCurrentHousehold = TierCalculator.calculateTierFromHousehold(householdMembers, params.memberId);
          const householdSize = householdMembers.length;
          
          console.log(`🔍 Tier validation for member ${params.memberId}:`, {
            frontendTier: memberCriteria.tier,
            frontendHouseholdSize: memberCriteria.householdSize,
            calculatedTier: calculatedTierFromCurrentHousehold,
            calculatedHouseholdSize: householdSize,
            householdMembers: householdMembers.map(m => ({ relationship: m.RelationshipType, isCurrentUser: m.IsCurrentUser }))
          });
          
          // ALWAYS use calculated tier from household composition when memberId is provided
          // However, if frontend's household size is DIFFERENT from current household size,
          // this likely means dependents are being added/removed, so trust the frontend's tier
          // Otherwise, use calculated tier to catch errors
          if (memberCriteria.householdSize !== householdSize) {
            // Household size mismatch - likely due to pending dependent changes
            // Trust the frontend's tier as it reflects the prospective household state
            console.log(`🔍 Household size mismatch: Frontend=${memberCriteria.householdSize}, Current=${householdSize}. Using frontend tier=${memberCriteria.tier} (likely due to pending dependent changes).`);
          } else if (memberCriteria.tier !== calculatedTierFromCurrentHousehold) {
            // Household size matches but tier doesn't - use calculated tier to catch errors
            console.log(`🔄 Tier correction: Frontend sent tier=${memberCriteria.tier}, but current household indicates tier=${calculatedTierFromCurrentHousehold}. Using calculated tier.`);
            memberCriteria = {
              ...memberCriteria,
              tier: calculatedTierFromCurrentHousehold,
              householdSize: householdSize
            };
          }
          
          // Also ensure groupId is set if not provided
          if (!groupId && member.GroupId) {
            groupId = member.GroupId;
          }
        }
      }
      
      if (params.calculationType === 'simulation') {
        // Apply simulation changes to current data
        const simulationData = await this.applySimulationChanges(params);
        productSelections = simulationData.productSelections;
        memberCriteria = simulationData.memberCriteria;
        groupId = simulationData.groupId;
      }

      console.log('🔍 DEBUG: Prepared data:', {
        productSelectionsCount: productSelections?.length || 0,
        memberCriteria,
        groupId
      });

      // 3. Calculate base pricing for each product
      const productPricingResults = [];
      const pricingErrors = [];
      const effectiveDate = params.effectiveDate || null; // Get effective date from params
      
      for (const selection of productSelections) {
        try {
          let productPricing;
          
          // Check if this is a bundle product
          const isBundle = await BundleProcessor.isBundleProduct(selection.productId);
          
          if (isBundle) {
            productPricing = await BundleProcessor.processBundleProduct(
              selection.productId, 
              memberCriteria,
              selection.configValues || {},
              effectiveDate,
              { tenantId: params.tenantId || null }
            );
          } else {
            productPricing = await this.calculateProductPricing(
              selection.productId,
              memberCriteria,
              selection.configValues || {},
              effectiveDate,
              { tenantId: params.tenantId || null }
            );
          }

          // Preserve the selected configValues on the calculated pricing result.
          // This is critical for subsequent "EquivalentTier" pricing where we re-price the same product
          // for a different tier (EE/ES/EC/EF). Without this, bundles can fall back to a default config,
          // causing EE-equivalent to be computed against the wrong unshared amount/option.
          productPricing.configValues = selection.configValues || {};
          
          productPricingResults.push(productPricing);
        } catch (error) {
          console.error(`Error calculating pricing for product ${selection.productId}:`, error);
          
          // Track pricing errors to inform frontend
          pricingErrors.push({
            productId: selection.productId,
            error: error.message || 'Pricing calculation failed',
            errorType: error.message?.includes('No pricing found') ? 'MISSING_PRICING_CONFIG' : 'PRICING_ERROR'
          });
          
          // Continue with other products even if one fails
        }
      }

      console.log('🔍 DEBUG: Calculated pricing for', productPricingResults.length, 'products');
      if (pricingErrors.length > 0) {
        console.log('⚠️ WARNING: Pricing errors for', pricingErrors.length, 'products:', pricingErrors);
      }

      // 3b. Populate equivalentPremiums for percentage rules with EquivalentTier (when group has such rules)
      //     and build equivalentTierBases (product total + system + processing fee on that total) so % covers fees too
      let equivalentTierBases = null;
      if (groupId && productPricingResults.length > 0) {
        try {
          const contributionRules = await ContributionCalculator.getGroupContributionRules(groupId);
          const equivalentTiers = [...new Set(
            (contributionRules || [])
              .filter(r => r.ContributionType === 'percentage' && r.EquivalentTier)
              .map(r => String(r.EquivalentTier).trim().toUpperCase())
          )];
          if (equivalentTiers.length > 0) {
            for (const product of productPricingResults) {
              product.equivalentPremiums = product.equivalentPremiums || {};
              const configValues = product.configValues || {};
              for (const tier of equivalentTiers) {
                if (memberCriteria.tier === tier) {
                  product.equivalentPremiums[tier] = product.monthlyPremium;
                  // For bundles, also store per-included-product equivalent premiums for this tier
                  // so downstream code can correctly compute equivalent totals without falling back
                  // to the member's actual tier pricing for included products.
                  if (product.isBundle === true && Array.isArray(product.includedProducts) && product.includedProducts.length > 0) {
                    for (const ip of product.includedProducts) {
                      if (!ip?.productId) continue;
                      ip.equivalentPremiums = ip.equivalentPremiums && typeof ip.equivalentPremiums === 'object' ? ip.equivalentPremiums : {};
                      ip.equivalentPremiums[tier] = Number(ip.monthlyPremium || 0);
                    }
                  }
                } else {
                  try {
                    let tierPricing;
                    if (product.isBundle) {
                      tierPricing = await BundleProcessor.processBundleProduct(
                        product.productId,
                        { ...memberCriteria, tier },
                        configValues,
                        effectiveDate,
                        { tenantId: params.tenantId || null }
                      );
                    } else {
                      tierPricing = await this.calculateProductPricing(
                        product.productId,
                        { ...memberCriteria, tier },
                        configValues,
                        effectiveDate,
                        { tenantId: params.tenantId || null }
                      );
                    }
                    product.equivalentPremiums[tier] = tierPricing.monthlyPremium;
                    // For bundles, store per-included-product equivalent premiums by tier as well.
                    // This prevents "EE equivalent" calculations from accidentally using actual-tier
                    // included product premiums when reconstructing bundle totals.
                    if (product.isBundle === true && Array.isArray(product.includedProducts) && product.includedProducts.length > 0) {
                      const tierIncluded = Array.isArray(tierPricing?.includedProducts) ? tierPricing.includedProducts : [];
                      const tierIncludedById = new Map(tierIncluded.map((x) => [String(x?.productId), x]));
                      for (const ip of product.includedProducts) {
                        if (!ip?.productId) continue;
                        const match = tierIncludedById.get(String(ip.productId));
                        ip.equivalentPremiums = ip.equivalentPremiums && typeof ip.equivalentPremiums === 'object' ? ip.equivalentPremiums : {};
                        ip.equivalentPremiums[tier] = Number(match?.monthlyPremium ?? ip.monthlyPremium ?? 0);
                      }
                    }
                  } catch (err) {
                    console.warn(`Failed to get ${tier} equivalent premium for product ${product.productId}:`, err.message);
                    product.equivalentPremiums[tier] = product.monthlyPremium;
                    if (product.isBundle === true && Array.isArray(product.includedProducts) && product.includedProducts.length > 0) {
                      for (const ip of product.includedProducts) {
                        if (!ip?.productId) continue;
                        ip.equivalentPremiums = ip.equivalentPremiums && typeof ip.equivalentPremiums === 'object' ? ip.equivalentPremiums : {};
                        ip.equivalentPremiums[tier] = Number(ip.monthlyPremium || 0);
                      }
                    }
                  }
                }
              }
            }
            // Base for % = equivalent product total + system fee + processing fee on that total
            try {
              const groupMemberFees = require('../../utils/groupMemberFees');
              const pool = await getPool();
              const tenantId = await groupMemberFees.getTenantIdForGroup(groupId, pool);
              if (tenantId) {
                equivalentTierBases = {};
                for (const tier of equivalentTiers) {
                  // ZeroFeeForACH: build per-product premium map for this tier so `getAdditionalFeesForMember`
                  // can pool zero-ACH products separately. Otherwise equivalent-tier bases used by group
                  // percentage rules would assume the inflated ACH rate for flagged products.
                  const basePremiumByProductId = new Map();
                  let productTotal = 0;
                  for (const p of productPricingResults) {
                    if (!p?.productId) continue;
                    const amt = Number(((p.equivalentPremiums && p.equivalentPremiums[tier]) ?? p.monthlyPremium) || 0);
                    if (amt <= 0) continue;
                    basePremiumByProductId.set(String(p.productId), Math.round((Number(basePremiumByProductId.get(String(p.productId)) || 0) + amt) * 100) / 100);
                    productTotal += amt;
                  }
                  const fees = await groupMemberFees.getAdditionalFeesForMember(groupId, tenantId, productTotal, pool, basePremiumByProductId);
                  equivalentTierBases[tier] = { productTotal, totalWithFees: productTotal + fees };
                }
              }
            } catch (e) {
              console.warn('Failed to build equivalentTierBases (fees on equivalent total):', e.message);
            }
          }
        } catch (err) {
          console.warn('Failed to populate equivalentPremiums for contribution rules:', err.message);
        }
      }

      // 4. Apply group contributions if member is in a group
      let contributionResults = { 
        employerTotal: 0, 
        employeeTotal: 0, 
        productContributions: {},
        appliedRules: [],
        calculationDetails: 'No group contributions'
      };

      if (groupId) {
        console.log('🔍 DEBUG: Applying group contributions for group:', groupId);
        contributionResults = await ContributionCalculator.calculateContributions({
          groupId: groupId,
          productPricingResults,
          memberCriteria,
          equivalentTierBases: equivalentTierBases || undefined
        });
      } else {
        // No group - member pays full premium
        const totalPremium = productPricingResults.reduce((sum, p) => sum + p.monthlyPremium, 0);
        contributionResults = {
          employerTotal: 0,
          employeeTotal: totalPremium,
          productContributions: this.createEmptyProductContributions(productPricingResults),
          appliedRules: [],
          calculationDetails: 'No group - member pays full premium'
        };
      }

      // 5. Calculate totals
      const totalPremium = productPricingResults.reduce((sum, p) => sum + p.monthlyPremium, 0);
      const totalEmployerContribution = contributionResults.employerTotal;
      const totalEmployeeContribution = contributionResults.employeeTotal;

      // 6. Apply individual product contributions to products
      const productsWithContributions = productPricingResults.map(product => {
        const productContribution = contributionResults.productContributions[product.productId] || {
          productSpecific: 0,
          allProductsShare: 0,
          total: 0,
          employeeContribution: product.monthlyPremium
        };
        
        const result = {
          ...product,
          employerContribution: productContribution.total,
          employeeContribution: productContribution.employeeContribution
        };

        // Debug logging for bundle products
        if (product.isBundle) {
          console.log(`🔍 DEBUG: Bundle product before mapping:`, {
            productId: product.productId,
            productName: product.productName,
            hasConfigurationFields: product.hasConfigurationFields,
            availableConfigs: product.availableConfigs,
            defaultConfig: product.defaultConfig
          });
          console.log(`🔍 DEBUG: Bundle product after mapping:`, {
            productId: result.productId,
            productName: result.productName,
            hasConfigurationFields: result.hasConfigurationFields,
            availableConfigs: result.availableConfigs,
            defaultConfig: result.defaultConfig
          });
        }
        
        return result;
      });

      // 7. Create unified result
      const result = {
        products: productsWithContributions,
        contributions: contributionResults,
        totals: {
          totalPremium,
          totalEmployerContribution,
          totalEmployeeContribution
        },
        calculationType: params.calculationType,
        memberId: params.memberId,
        groupId: groupId,
        calculatedAt: new Date().toISOString(),
        // Include pricing errors so frontend knows which products failed
        pricingErrors: pricingErrors.length > 0 ? pricingErrors : undefined
      };

      // 7. Validate result
      PricingValidator.validatePricingResult(result);

      console.log('✅ DEBUG: Pricing calculation completed successfully');
      if (pricingErrors.length > 0) {
        console.log('⚠️ WARNING: Response includes pricing errors for products:', pricingErrors.map(e => e.productId));
      }
      return result;

    } catch (error) {
      console.error('❌ Error in calculatePricing:', error);
      throw new Error(`Pricing calculation failed: ${error.message}`);
    }
  }

  /**
   * Calculate pricing for a single product
   * @param {string} productId - Product ID
   * @param {Object} memberCriteria - Member criteria
   * @param {Object} configValues - Configuration values
   * @returns {Object} Product pricing result
   */
  /**
   * Attach included processing fee fields from product + pricing row (base monthlyPremium unchanged).
   */
  static async applyProcessingFeeEnrichment(pricingResult, productId, options = {}) {
    if (!pricingResult || !productId) return pricingResult;

    const pool = await getPool();
    const productFlagsMap = await productProcessingFeesUtil.loadProductFeeFlagsFromProducts({
      poolOrTransaction: pool,
      productIds: [productId]
    });
    const pf = productFlagsMap.get(String(productId)) || {};
    const productFeeFlags = {
      includeProcessingFee: pf.includeProcessingFeeFromProduct === true,
      roundUpProcessingFee: pf.roundUpProcessingFee !== false,
      includeProcessingFeeFromSubscription: false, // deprecated — includedFeeDeprecation.js
      zeroFeeForACH: false
    };

    let paymentProcessorSettings = null;
    let chargeFeeToMemberEnabled = false;
    if (options.tenantId) {
      const req = pool.request();
      req.input('tenantId', sql.UniqueIdentifier, options.tenantId);
      const tenantRes = await req.query(`
        SELECT TOP 1 PaymentProcessorSettings FROM oe.Tenants WHERE TenantId = @tenantId
      `);
      const rawPps = tenantRes.recordset?.[0]?.PaymentProcessorSettings;
      if (rawPps) {
        try {
          paymentProcessorSettings = typeof rawPps === 'string' ? JSON.parse(rawPps) : rawPps;
        } catch (_) {}
      }
      chargeFeeToMemberEnabled = paymentProcessorSettings?.chargeFeeToMember === true;
    }

    const enrichOne = (row, storedIncluded) => {
      const base = {
        ...row,
        pricingDetails: {
          ...(row.pricingDetails || {}),
          includedProcessingFee: storedIncluded != null ? Number(storedIncluded) : row.pricingDetails?.includedProcessingFee
        }
      };
      return includedProcessingFeeUtil.enrichPricingResultWithIncludedFee(
        base,
        productFeeFlags,
        paymentProcessorSettings,
        chargeFeeToMemberEnabled
      );
    };

    const variations = (pricingResult.pricingVariations || []).map((v) =>
      enrichOne(v, v.pricingDetails?.includedProcessingFee)
    );

    const mainStored = pricingResult.pricingDetails?.includedProcessingFee;
    const enrichedMain = enrichOne(
      {
        ...pricingResult,
        monthlyPremium: pricingResult.monthlyPremium,
        basePremium: pricingResult.basePremium,
        pricingDetails: pricingResult.pricingDetails
      },
      mainStored
    );

    return {
      ...pricingResult,
      monthlyPremium: enrichedMain.monthlyPremium,
      basePremium: enrichedMain.basePremium,
      includedProcessingFee: enrichedMain.includedProcessingFee,
      displayPremium: enrichedMain.displayPremium,
      pricingDetails: enrichedMain.pricingDetails,
      pricingVariations: variations
    };
  }

  static async calculateProductPricing(productId, memberCriteria, configValues = {}, effectiveDate = null, options = {}) {
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('productId', sql.UniqueIdentifier, productId);
      request.input('tierType', sql.NVarChar(10), memberCriteria.tier);
      request.input('memberAge', sql.Int, memberCriteria.age);
      // Normalize tobacco use for database lookup
      const normalizedTobaccoStatus = this.normalizeTobaccoStatus(memberCriteria.tobaccoUse);
      request.input('tobaccoStatus', sql.NVarChar(50), normalizedTobaccoStatus);

      // Always resolve pricing as-of a date: enrollment effective date when provided, else today.
      // Without this, terminated rate rows (TerminationDate in the past) still marked Active leak in.
      const pricingAsOfDate =
        effectiveDate != null && String(effectiveDate).trim() !== ''
          ? effectiveDate
          : new Date().toISOString().split('T')[0];
      request.input('effectiveDate', sql.Date, pricingAsOfDate);

      // Get product information with RequiredDataFields
      const productResult = await request.query(`
        SELECT 
          p.ProductId,
          p.Name as ProductName,
          p.ProductType,
          p.IsBundle,
          p.IsVendorPrice,
          p.Description,
          p.RequiredDataFields
        FROM oe.Products p
        WHERE p.ProductId = @productId
          AND p.Status = 'Active'
      `);

      if (productResult.recordset.length === 0) {
        throw new Error(`Product not found: ${productId}`);
      }

      const product = productResult.recordset[0];

      // Get ALL pricing information for this product (all configuration options)
      // Filter by pricingAsOfDate: EffectiveDate <= date AND (TerminationDate IS NULL OR TerminationDate >= date)
      // If multiple records match, use ROW_NUMBER to pick the most recent EffectiveDate
      const pricingQuery = `
        SELECT 
          pp.ProductPricingId,
          pp.NetRate,
          pp.OverrideRate,
          pp.VendorCommission,
          pp.SystemFees,
          pp.MSRPRate,
          pp.IncludedProcessingFee,
          pp.MinAge,
          pp.MaxAge,
          pp.TobaccoStatus,
          pp.TierType,
          pp.Label,
          pp.ConfigField1,
          pp.ConfigField2,
          pp.ConfigField3,
          pp.ConfigField4,
          pp.ConfigField5,
          pp.ConfigValue1,
          pp.ConfigValue2,
          pp.ConfigValue3,
          pp.ConfigValue4,
          pp.ConfigValue5,
          pp.Status,
          pp.EffectiveDate,
          pp.TerminationDate
        FROM (
          SELECT 
            pp.*,
            ROW_NUMBER() OVER (
              PARTITION BY pp.ProductId, pp.TierType, pp.MinAge, pp.MaxAge, pp.TobaccoStatus, 
                         pp.ConfigValue1, pp.ConfigValue2, pp.ConfigValue3, pp.ConfigValue4, pp.ConfigValue5
              ORDER BY pp.EffectiveDate DESC, pp.ProductPricingId DESC
            ) AS RowNum
          FROM oe.ProductPricing pp
          WHERE pp.ProductId = @productId
            AND pp.TierType = @tierType
            AND pp.Status = 'Active'
            AND pp.MinAge <= @memberAge
            AND (pp.MaxAge IS NULL OR pp.MaxAge >= @memberAge)
            AND (pp.TobaccoStatus = @tobaccoStatus OR pp.TobaccoStatus = 'N/A')
            AND CAST(pp.EffectiveDate AS DATE) <= @effectiveDate
            AND (pp.TerminationDate IS NULL OR CAST(pp.TerminationDate AS DATE) >= @effectiveDate)
        ) pp
        WHERE pp.RowNum = 1
        ORDER BY pp.MinAge DESC
      `;

      const pricingResult = await request.query(pricingQuery);

      if (pricingResult.recordset.length === 0) {
        // Diagnostic query to help identify the issue
        // Check what pricing records exist for this product (regardless of criteria)
        const diagnosticQuery = `
          SELECT 
            pp.TierType,
            pp.MinAge,
            pp.MaxAge,
            pp.TobaccoStatus,
            pp.EffectiveDate,
            pp.TerminationDate,
            pp.Status,
            COUNT(*) as Count
          FROM oe.ProductPricing pp
          WHERE pp.ProductId = @productId
            AND pp.Status = 'Active'
            AND CAST(pp.EffectiveDate AS DATE) <= @effectiveDate
            AND (pp.TerminationDate IS NULL OR CAST(pp.TerminationDate AS DATE) >= @effectiveDate)
          GROUP BY pp.TierType, pp.MinAge, pp.MaxAge, pp.TobaccoStatus, pp.EffectiveDate, pp.TerminationDate, pp.Status
          ORDER BY pp.TierType, pp.MinAge
        `;
        
        const diagnosticResult = await request.query(diagnosticQuery);
        const availableTiers = [...new Set(diagnosticResult.recordset.map(r => r.TierType))];
        const tierPricingCount = diagnosticResult.recordset.filter(r => r.TierType === memberCriteria.tier).length;
        
        // Also check what age ranges are available for the requested tier
        const tierAgeRanges = diagnosticResult.recordset
          .filter(r => r.TierType === memberCriteria.tier)
          .map(r => `${r.MinAge}-${r.MaxAge || 'NULL'}`)
          .filter((v, i, a) => a.indexOf(v) === i); // Remove duplicates
        
        console.error(`❌ Pricing lookup failed for product:`, {
          productId: productId.substring(0, 8) + '...',
          productName: product.ProductName,
          requestedTier: memberCriteria.tier,
          requestedAge: memberCriteria.age,
          requestedTobacco: memberCriteria.tobaccoUse,
          effectiveDate: pricingAsOfDate,
          availableTiers: availableTiers,
          tierPricingCount: tierPricingCount,
          tierAgeRanges: tierAgeRanges || [],
          totalPricingRecords: diagnosticResult.recordset.length
        });
        
        // Build a more helpful error message
        let errorMessage = `No pricing found for product "${product.ProductName}" (${productId.substring(0, 8)}...) with tier ${memberCriteria.tier}, age ${memberCriteria.age}, tobacco ${memberCriteria.tobaccoUse}`;
        errorMessage += ` for effective date ${pricingAsOfDate}`;
        if (availableTiers.length > 0 && !availableTiers.includes(memberCriteria.tier)) {
          errorMessage += `. Available tiers for this product: ${availableTiers.join(', ')}. Please ensure pricing data exists for tier ${memberCriteria.tier}.`;
        } else if (tierPricingCount === 0) {
          errorMessage += `. No pricing records exist for tier ${memberCriteria.tier} for this product. Please add pricing data for tier ${memberCriteria.tier}.`;
        } else if (tierAgeRanges && tierAgeRanges.length > 0) {
          errorMessage += `. Available age ranges for tier ${memberCriteria.tier}: ${tierAgeRanges.join(', ')}. Requested age ${memberCriteria.age} is not covered.`;
        } else {
          errorMessage += `. Please verify pricing data exists for tier ${memberCriteria.tier}, age ${memberCriteria.age}, tobacco ${memberCriteria.tobaccoUse}`;
        }
        
        throw new Error(errorMessage);
      }

      // Process all pricing records to create pricing variations
      const pricingVariations = pricingResult.recordset.map(pricing => {
        const netRate = Number(pricing.NetRate) || 0;
        const overrideRate = Number(pricing.OverrideRate) || 0;
        const vendorCommission = Number(pricing.VendorCommission) || 0;
        const systemFees = Number(pricing.SystemFees) || 0;
        const componentSum = netRate + overrideRate + vendorCommission + systemFees;
        const msrp = Number(pricing.MSRPRate) || 0;
        const storedIncluded = Number(pricing.IncludedProcessingFee) || 0;

        // MSRPRate may store member retail (components + included) or legacy base-only.
        let basePremium = msrp;
        if (storedIncluded > 0) {
          const retailTotal = Math.round((componentSum + storedIncluded) * 100) / 100;
          if (Math.abs(msrp - retailTotal) <= 0.02) {
            basePremium = componentSum;
          }
        }

        // Get configuration value for this pricing record
        const configValue = pricing.ConfigValue1 || pricing.ConfigValue2 || pricing.ConfigValue3 || pricing.ConfigValue4 || pricing.ConfigValue5 || 'Default';

        return {
          configValue,
          monthlyPremium: basePremium,
          basePremium,
          configAdjustment: 0, // No adjustment needed since we're using the specific pricing record
          // Calculate contributions for this specific pricing variation
          employerContribution: 0, // Will be calculated by ContributionCalculator
          employeeContribution: basePremium, // Default to full cost, will be updated by ContributionCalculator
          pricingDetails: {
            productPricingId: pricing.ProductPricingId, // Store ProductPricingId for enrollment snapshot
            netRate,
            overrideRate,
            vendorCommission,
            systemFees,
            includedProcessingFee: storedIncluded,
            isVendorPrice: product.IsVendorPrice
          }
        };
      });

      // Prefer configuration from EnrollmentDetails + ProductPricingId snapshot — JSON "configuration"
      // can drift; oe.Enrollments.ProductPricingId resolves the correct ProductPricing.ConfigValue*.
      let effectiveConfigValues =
        configValues && typeof configValues === 'object' ? { ...configValues } : {};
      const snapIdRaw =
        effectiveConfigValues.productPricingId || effectiveConfigValues.ProductPricingId;
      if (snapIdRaw != null && String(snapIdRaw).trim()) {
        try {
          const snapReq = pool.request();
          snapReq.input('ppsId', sql.UniqueIdentifier, snapIdRaw);
          snapReq.input('ppsProductId', sql.UniqueIdentifier, productId);
          const snapRs = await snapReq.query(`
            SELECT TOP 1
              ConfigValue1, ConfigValue2, ConfigValue3, ConfigValue4, ConfigValue5
            FROM oe.ProductPricing
            WHERE ProductPricingId = @ppsId AND ProductId = @ppsProductId AND Status = 'Active'
          `);
          const prow = snapRs.recordset?.[0];
          if (prow) {
            for (let i = 1; i <= 5; i += 1) {
              const cv = prow[`ConfigValue${i}`];
              if (cv != null && String(cv).trim() !== '') {
                effectiveConfigValues[`configValue${i}`] = String(cv).trim();
              }
            }
          }
        } catch (snapErr) {
          console.warn(
            `[PricingEngine] ProductPricing snapshot lookup skipped for ProductId=${productId}:`,
            snapErr.message
          );
        }
      }

      const normGuidFlat = (g) =>
        String(g ?? '')
          .replace(/-/g, '')
          .toLowerCase()
          .trim();

      // If specific config values are provided, find the matching variation
      let selectedPricing = pricingVariations[0]; // Default to first
      let matchedByPricingId = false;

      const snapWant = snapIdRaw != null && String(snapIdRaw).trim() ? normGuidFlat(snapIdRaw) : '';
      if (snapWant && pricingVariations.length > 0) {
        const bySnap = pricingVariations.find((p) =>
          normGuidFlat(p.pricingDetails?.productPricingId) === snapWant
        );
        if (bySnap) {
          selectedPricing = bySnap;
          matchedByPricingId = true;
        }
      }

      if (!matchedByPricingId && Object.keys(effectiveConfigValues).length > 0) {
        const requestedConfigValue =
          effectiveConfigValues.configValue1 ||
          effectiveConfigValues.ConfigValue1 ||
          '';
        if (requestedConfigValue && String(requestedConfigValue).trim() !== '' && String(requestedConfigValue) !== 'Default') {
          const want = String(requestedConfigValue);
          const matchingPricing = pricingVariations.find((p) => String(p.configValue) === want);
          if (matchingPricing) {
            selectedPricing = matchingPricing;
          }
        }
      }

      const requestedCfgForWarn =
        effectiveConfigValues.configValue1 || effectiveConfigValues.ConfigValue1;
      if (
        typeof requestedCfgForWarn !== 'undefined' &&
        requestedCfgForWarn !== null &&
        requestedCfgForWarn !== '' &&
        String(requestedCfgForWarn).trim() !== '' &&
        String(requestedCfgForWarn) !== 'Default' &&
        pricingVariations.length > 0 &&
        !pricingVariations.some((p) => String(p.configValue) === String(requestedCfgForWarn))
      ) {
        console.warn(
          `[PricingEngine] Config "${requestedCfgForWarn}" has no Active pricing variation for "${product.ProductName}" (ProductId=${String(productId).slice(0, 8)}…); tier=${memberCriteria.tier} age=${memberCriteria.age}; using cheapest row MSRPRate=$${pricingVariations[0].monthlyPremium}.`
        );
      }

      // Parse RequiredDataFields to get proper field names and options
      let requiredDataFields = [];
      let availableConfigs = [];
      
      try {
        if (product.RequiredDataFields) {
          const parsedFields = typeof product.RequiredDataFields === 'string' 
            ? JSON.parse(product.RequiredDataFields) 
            : product.RequiredDataFields;
          
          if (Array.isArray(parsedFields)) {
            requiredDataFields = parsedFields;
            // Get all unique options from all fields for the dropdown
            availableConfigs = [];
            parsedFields.forEach(field => {
              if (field.fieldOptions && Array.isArray(field.fieldOptions)) {
                availableConfigs.push(...field.fieldOptions);
              }
            });
            // Remove duplicates
            availableConfigs = [...new Set(availableConfigs)];
          }
        }
      } catch (error) {
        console.warn('Failed to parse RequiredDataFields:', error);
      }

      // If no RequiredDataFields, fall back to ConfigField1-5 from ProductPricing
      if (requiredDataFields.length === 0) {
        // Use the first pricing record to get configuration fields
        const firstPricing = pricingResult.recordset[0];
        for (let i = 1; i <= 5; i++) {
          const configField = firstPricing[`ConfigField${i}`];
          const configValue = firstPricing[`ConfigValue${i}`];
          if (configField && configField !== null && configField !== '') {
            requiredDataFields.push({
              fieldName: configField,
              fieldType: 'select',
              options: configValue ? [configValue] : []
            });
            if (configValue) {
              availableConfigs.push(configValue);
            }
          }
        }
      }

      // Non-configurable products (e.g. GetWell Dental) have no UA — only a single effective rate row.
      // Do not expose synthetic configValue "Default" rows to the client; frontend uses monthlyPremium only.
      const hasSelectableConfig =
        availableConfigs.length > 0 ||
        pricingVariations.some((v) => {
          const c = v.configValue != null ? String(v.configValue) : '';
          return c !== '' && c !== 'Default';
        });
      let configsForClient = availableConfigs;
      if (configsForClient.length === 0 && hasSelectableConfig) {
        configsForClient = [
          ...new Set(
            pricingVariations
              .map((v) => (v.configValue != null ? String(v.configValue) : ''))
              .filter((c) => c !== '' && c !== 'Default')
          )
        ].sort();
      }

      const result = {
        productId: product.ProductId,
        productName: product.ProductName,
        productType: product.ProductType,
        isBundle: product.IsBundle,
        tierType: selectedPricing.pricingDetails.netRate > 0 ? pricingResult.recordset[0].TierType : 'Unknown',
        tobaccoStatus: selectedPricing.pricingDetails.netRate > 0 ? pricingResult.recordset[0].TobaccoStatus : 'Unknown',
        memberAge: memberCriteria.age,
        monthlyPremium: selectedPricing.monthlyPremium,
        basePremium: selectedPricing.basePremium,
        configAdjustment: selectedPricing.configAdjustment,
        // Set main contribution fields for products without configuration fields
        employerContribution: selectedPricing.employerContribution,
        employeeContribution: selectedPricing.employeeContribution,
        pricingDetails: selectedPricing.pricingDetails,
        configValues: effectiveConfigValues,
        // Configuration fields for frontend
        hasConfigurationFields: hasSelectableConfig,
        availableConfigs: configsForClient,
        requiredDataFields: requiredDataFields,
        defaultConfig: hasSelectableConfig && configsForClient.length > 0 ? configsForClient[0] : null,
        // UA buffet only when the member actually chooses a config (2500/5000/etc.)
        pricingVariations: hasSelectableConfig ? pricingVariations : [],
        calculatedAt: new Date().toISOString()
      };

      return await this.applyProcessingFeeEnrichment(result, productId, options);

    } catch (error) {
      console.error(`Error calculating product pricing for ${productId}:`, error);
      throw new Error(`Product pricing calculation failed: ${error.message}`);
    }
  }

  /**
   * Normalize tobacco use status for database lookup
   * @param {string} tobaccoUse - Tobacco use value from frontend
   * @returns {string} Normalized tobacco status for database
   */
  static normalizeTobaccoStatus(tobaccoUse) {
    const normalized = tobaccoUse?.toString().toLowerCase();
    
    // Map various tobacco use values to database values
    if (normalized === 'no' || normalized === 'n') {
      return 'No';
    } else if (normalized === 'yes' || normalized === 'y') {
      return 'Yes';
    } else if (normalized === 'unknown' || normalized === 'u') {
      return 'Unknown';
    }
    
    // Default to the original value if no mapping found
    return tobaccoUse;
  }

  /**
   * Calculate configuration-based pricing adjustment
   * @param {Object} pricing - Pricing record
   * @param {Object} configValues - Configuration values
   * @returns {number} Configuration adjustment amount
   */
  static calculateConfigAdjustment(pricing, configValues) {
    let adjustment = 0;

    // Apply configuration value adjustments
    for (let i = 1; i <= 5; i++) {
      const configValue = configValues[`configValue${i}`] || configValues[`ConfigValue${i}`];
      const pricingConfigValue = pricing[`ConfigValue${i}`];
      
      if (configValue && pricingConfigValue) {
        // Simple multiplication for now - can be made more complex
        adjustment += Number(configValue) * Number(pricingConfigValue);
      }
    }

    return adjustment;
  }

  /**
   * Get current member data for current calculations
   * @param {string} memberId - Member ID
   * @returns {Object} Current member data
   */
  static async getCurrentMemberData(memberId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('memberId', sql.UniqueIdentifier, memberId);

      // Get member and household information
      const memberResult = await request.query(`
        SELECT 
          m.MemberId,
          m.UserId,
          m.GroupId,
          u.FirstName,
          u.LastName,
          m.DateOfBirth,
          m.TobaccoUse,
          m.RelationshipType,
          m.HouseholdId
        FROM oe.Members m
        INNER JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.MemberId = @memberId
          AND m.Status = 'Active'
      `);

      if (memberResult.recordset.length === 0) {
        throw new Error(`Member not found: ${memberId}`);
      }

      const member = memberResult.recordset[0];

      // Add householdId and userId parameters for the next query
      request.input('householdId', sql.UniqueIdentifier, member.HouseholdId);
      request.input('userId', sql.UniqueIdentifier, member.UserId);

      // Get household members to calculate tier
      const householdResult = await request.query(`
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
      `);

      const householdMembers = householdResult.recordset;
      const tier = TierCalculator.calculateTierFromHousehold(householdMembers, memberId);
      const age = TierCalculator.calculateAge(member.DateOfBirth);

      // Get current enrollments
      const enrollmentsResult = await request.query(`
        SELECT 
          e.ProductId,
          e.EnrollmentId,
          p.Name as ProductName,
          p.IsBundle
        FROM oe.Enrollments e
        INNER JOIN oe.Products p ON e.ProductId = p.ProductId
        WHERE e.MemberId = @memberId
          AND e.Status = 'Active'
          AND p.Status = 'Active'
      `);

      const productSelections = enrollmentsResult.recordset.map(enrollment => ({
        productId: enrollment.ProductId,
        isBundle: enrollment.IsBundle,
        configValues: {} // TODO: Get actual config values from enrollment
      }));

      return {
        productSelections,
        memberCriteria: {
          age: age,
          tobaccoUse: member.TobaccoUse || 'No',
          tier: tier,
          householdSize: TierCalculator.getHouseholdSizeFromTier(tier)
        },
        groupId: member.GroupId
      };

    } catch (error) {
      console.error(`Error getting current member data for ${memberId}:`, error);
      throw new Error(`Failed to get current member data: ${error.message}`);
    }
  }

  /**
   * Apply simulation changes to current data
   * @param {Object} params - Simulation parameters
   * @returns {Object} Modified data for simulation
   */
  static async applySimulationChanges(params) {
    try {
      // Get current data first
      const currentData = await this.getCurrentMemberData(params.memberId);
      
      // Apply simulation changes
      const simulationContext = params.simulationContext;
      let modifiedData = { ...currentData };

      // Handle dependent changes
      if (simulationContext.changes) {
        if (simulationContext.changes.addDependents) {
          // Recalculate tier with additional dependents
          const newTier = this.calculateTierWithAdditionalDependents(
            currentData.memberCriteria.tier,
            simulationContext.changes.addDependents
          );
          modifiedData.memberCriteria.tier = newTier;
          modifiedData.memberCriteria.householdSize = TierCalculator.getHouseholdSizeFromTier(newTier);
        }

        if (simulationContext.changes.removeDependents) {
          // Recalculate tier with removed dependents
          const newTier = this.calculateTierWithRemovedDependents(
            currentData.memberCriteria.tier,
            simulationContext.changes.removeDependents
          );
          modifiedData.memberCriteria.tier = newTier;
          modifiedData.memberCriteria.householdSize = TierCalculator.getHouseholdSizeFromTier(newTier);
        }

        // Handle product changes
        if (simulationContext.changes.addProducts) {
          const newProducts = simulationContext.changes.addProducts.map(productId => ({
            productId,
            isBundle: false, // TODO: Check if bundle
            configValues: {}
          }));
          modifiedData.productSelections = [...currentData.productSelections, ...newProducts];
        }

        if (simulationContext.changes.removeProducts) {
          const removeProductIds = simulationContext.changes.removeProducts;
          modifiedData.productSelections = currentData.productSelections.filter(
            selection => !removeProductIds.includes(selection.productId)
          );
        }
      }

      return modifiedData;

    } catch (error) {
      console.error(`Error applying simulation changes:`, error);
      throw new Error(`Simulation failed: ${error.message}`);
    }
  }

  /**
   * Calculate tier with additional dependents
   * @param {string} currentTier - Current tier
   * @param {Array} newDependents - New dependents to add
   * @returns {string} New tier
   */
  static calculateTierWithAdditionalDependents(currentTier, newDependents) {
    // Simple logic - can be made more sophisticated
    const hasSpouse = currentTier === 'ES' || currentTier === 'EF' || 
                     newDependents.some(dep => dep.relationshipType === 'S' || dep.relationshipType === 'Spouse');
    const childrenCount = newDependents.filter(dep => 
      dep.relationshipType === 'C' || dep.relationshipType === 'Child'
    ).length;

    return TierCalculator.calculateMemberTier(hasSpouse, childrenCount);
  }

  /**
   * Calculate tier with removed dependents
   * @param {string} currentTier - Current tier
   * @param {Array} removedDependents - Dependents to remove
   * @returns {string} New tier
   */
  static calculateTierWithRemovedDependents(currentTier, removedDependents) {
    // Simple logic - can be made more sophisticated
    const removedSpouse = removedDependents.some(dep => dep.relationshipType === 'S' || dep.relationshipType === 'Spouse');
    const removedChildren = removedDependents.filter(dep => 
      dep.relationshipType === 'C' || dep.relationshipType === 'Child'
    ).length;

    // This is simplified - in reality, we'd need to know the current household composition
    if (removedSpouse && currentTier === 'ES') {
      return 'EE';
    }
    if (removedSpouse && currentTier === 'EF') {
      return 'EC';
    }
    if (removedChildren > 0 && currentTier === 'EC') {
      return 'EE';
    }
    if (removedChildren > 0 && currentTier === 'EF') {
      return 'ES';
    }

    return currentTier;
  }

  /**
   * Create empty product contributions structure
   * @param {Array} productPricingResults - Product pricing results
   * @returns {Object} Empty contributions structure
   */
  static createEmptyProductContributions(productPricingResults) {
    const contributions = {};
    
    for (const product of productPricingResults) {
      contributions[product.productId] = {
        productSpecific: 0,
        allProductsShare: 0,
        total: 0,
        employeeContribution: product.monthlyPremium
      };
    }

    return contributions;
  }
}

module.exports = PricingEngine;
