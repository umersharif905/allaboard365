// backend/services/EnrollmentCompletionService.js
const sql = require('mssql');
const crypto = require('crypto');
const { getPool } = require('../config/database');
const { PricingEngine } = require('./pricing');
const ContributionCalculator = require('./pricing/ContributionCalculator');
const { generateAgreementsPDF } = require('../utils/pdfGenerator');
const { getMemberAgeForPricing } = require('../utils/memberAgeFromDob');

/**
 * Shared service for handling enrollment completion logic
 * Used by both enrollment wizard and product change workflows
 */
class EnrollmentCompletionService {
  
  /**
   * Get product-specific contribution rule for a group and product
   * @param {string} groupId - Group ID
   * @param {string} productId - Product ID
   * @param {Date} effectiveDate - Effective date for the enrollment
   * @param {Object} transaction - Database transaction
   * @returns {Promise<string|null>} - Contribution ID or null if no product-specific rule found
   */
  static async getProductSpecificContributionRule(groupId, productId, effectiveDate, transaction) {
    try {
      const contributionQuery = `
        SELECT TOP 1 gc.ContributionId
        FROM oe.GroupContributions gc
        WHERE gc.GroupId = @groupId
          AND gc.ProductId = @productId
          AND gc.Status = 'Active'
          AND gc.EffectiveDate <= @effectiveDate
          AND (gc.EndDate IS NULL OR gc.EndDate >= @effectiveDate)
        ORDER BY gc.Priority ASC
      `;

      const contributionRequest = transaction.request();
      contributionRequest.input('groupId', sql.UniqueIdentifier, groupId);
      contributionRequest.input('productId', sql.UniqueIdentifier, productId);
      contributionRequest.input('effectiveDate', sql.Date, effectiveDate);

      const contributionResult = await contributionRequest.query(contributionQuery);

      if (contributionResult.recordset.length > 0) {
        const contributionId = contributionResult.recordset[0].ContributionId;
        console.log(`✅ Found product-specific contribution rule: ${contributionId} for product ${productId}`);
        return contributionId;
      } else {
        console.log(`ℹ️ No product-specific contribution rule found for product ${productId}`);
        return null;
      }
    } catch (error) {
      console.error('❌ Error looking up product-specific contribution rule:', error);
      return null;
    }
  }

  /**
   * Complete enrollment for selected products
   * @param {Object} params - Enrollment parameters
   * @param {string} params.memberId - Primary member ID
   * @param {Array} params.selectedProducts - Array of selected product IDs
   * @param {Object} params.selectedConfigs - Configuration values for products
   * @param {Array} params.frontendPricing - Frontend-calculated pricing for validation
   * @param {Array} params.householdMembers - All household members
   * @param {string} params.effectiveDate - Effective date for enrollments
   * @param {Array} params.acknowledgements - Product acknowledgements
   * @param {string} params.digitalSignature - Digital signature
   * @param {Object} params.memberInfo - Member information
   * @param {string} params.ipAddress - User's IP address
   * @param {string} params.userAgent - User's user agent
   * @param {Object} params.transaction - Database transaction
   * @param {Object} params.member - Member data from database
   * @returns {Promise<Object>} - Result with created/updated enrollments
   */
  static async completeEnrollment({
    memberId,
    selectedProducts,
    selectedConfigs = {},
    frontendPricing = [],
    householdMembers = [],
    effectiveDate,
    acknowledgements = [],
    digitalSignature = '',
    memberInfo = {},
    ipAddress = '127.0.0.1',
    userAgent = '',
    transaction,
    member,
    calculatedTier = null,
    newTobaccoUse = null
  }) {
    console.log('🔍 EnrollmentCompletionService: Starting enrollment completion', {
      memberId,
      selectedProductsCount: selectedProducts?.length || 0,
      hasAcknowledgements: acknowledgements?.length > 0,
      hasDigitalSignature: !!digitalSignature,
      householdMembersCount: householdMembers?.length || 0
    });

    const createdEnrollments = [];
    const updatedEnrollments = [];
    const errors = [];

    try {
      // Get all household members (primary + dependents)
      // Get HouseholdId from member (member should have HouseholdId from caller)
      const householdId = member.HouseholdId || null;
      
      const allHouseholdMembers = [
        {
          MemberId: memberId,
          FirstName: member.FirstName,
          LastName: member.LastName,
          RelationshipType: 'P',
          AgentId: member.AgentId,
          HouseholdId: householdId
        },
        ...householdMembers.map(m => ({ ...m, HouseholdId: m.HouseholdId || householdId }))
      ];

      console.log(`🔍 Processing ${allHouseholdMembers.length} household members`);

      // Process each selected product
      for (const productId of selectedProducts) {
        console.log(`🔍 Processing product: ${productId}`);

        try {
          // Get product details
          const productQuery = `
            SELECT 
              p.ProductId,
              p.Name,
              p.VendorProductID,
              p.IsBundle,
              p.Status
            FROM oe.Products p
            WHERE p.ProductId = @productId
              AND p.Status = 'Active'
          `;

          const productRequest = transaction.request();
          productRequest.input('productId', sql.UniqueIdentifier, productId);
          const productResult = await productRequest.query(productQuery);

          if (productResult.recordset.length === 0) {
            console.warn(`⚠️ Product ${productId} not found or inactive`);
            continue;
          }

          const product = productResult.recordset[0];
          console.log(`🔍 Processing product: ${product.Name} (${product.IsBundle ? 'Bundle' : 'Individual'})`);

          // Calculate pricing
          let householdPremium = 0;
          let pricingDetails = null; // Will store pricing details for enrollment snapshot
          const primaryMember = allHouseholdMembers.find(m => m.RelationshipType === 'P');

          // Get selected configuration for this product - MOVED OUTSIDE primaryMember block
          const productConfigValue = selectedConfigs[productId] || null;
          const configValues = productConfigValue ? { configValue1: productConfigValue } : {};
          
          // Prepare member criteria for pricing calculation - MOVED OUTSIDE primaryMember block
          // Use wizard overrides if provided, otherwise use member's current values
          const tierToUse = calculatedTier || member.Tier || 'EE';
          const tobaccoToUse = newTobaccoUse || (member.TobaccoUse === 'Y' ? 'Yes' : 'No');
          
          const memberCriteria = {
            age: getMemberAgeForPricing(member.DateOfBirth, 30),
            tobaccoUse: tobaccoToUse,
            tier: tierToUse,
            hasSpouse: allHouseholdMembers.some(m => m.RelationshipType === 'S'),
            childrenCount: allHouseholdMembers.filter(m => m.RelationshipType === 'C').length,
            householdSize: allHouseholdMembers.length
          };
          
          if (primaryMember) {
            console.log(`🔍 Calculating pricing for ${product.Name}`);
            
            try {
              console.log('🔍 EnrollmentCompletionService using criteria:', {
                tierOverride: calculatedTier,
                tobaccoOverride: newTobaccoUse,
                tierToUse,
                tobaccoToUse,
                memberDbTier: member.Tier,
                memberDbTobacco: member.TobaccoUse
              });

              // Calculate pricing using PricingEngine
              let pricingResult;

              if (product.IsBundle) {
                // For bundles, use the main calculatePricing method
                const bundleSelections = [{
                  productId: productId,
                  configValues: configValues
                }];

                const bundleResults = await PricingEngine.calculatePricing({
                  calculationType: 'enrollment',
                  memberCriteria: memberCriteria,
                  productSelections: bundleSelections,
                  effectiveDate: effectiveDate || null
                });

                pricingResult = bundleResults.products[0];

                // Apply bundle configuration to included products
                if (pricingResult && pricingResult.includedProducts) {
                  for (const includedProduct of pricingResult.includedProducts) {
                    if (includedProduct.hasConfigurationFields) {
                      // Check for sub-product specific config first (format: {bundleId}-{subProductId})
                      const subProductConfigKey = `${productId}-${includedProduct.productId}`;
                      const subProductConfig = selectedConfigs[subProductConfigKey];
                      
                      // Use sub-product specific config if available, otherwise use bundle-level config
                      const configToUse = subProductConfig || configValues.configValue1;
                      
                      console.log(`🔍 Bundle component config lookup:`, {
                        includedProductId: includedProduct.productId?.substring(0, 8),
                        subProductConfigKey: subProductConfigKey?.substring(0, 50),
                        subProductConfig,
                        bundleLevelConfig: configValues.configValue1,
                        configToUse
                      });
                      
                      if (configToUse && includedProduct.availableConfigs.includes(configToUse)) {
                        const matchingVariation = includedProduct.pricingVariations?.find(v => v.configValue === configToUse);
                        if (matchingVariation) {
                          console.log(`✅ Applied config "${configToUse}" to ${includedProduct.productName || includedProduct.productId}: $${matchingVariation.monthlyPremium}`);
                          includedProduct.monthlyPremium = matchingVariation.monthlyPremium;
                          includedProduct.basePremium = matchingVariation.basePremium;
                          includedProduct.employeeContribution = matchingVariation.employeeContribution;
                        }
                      }
                    }
                  }

                  // Recalculate the total bundle premium
                  const newTotalPremium = pricingResult.includedProducts.reduce((sum, p) => sum + p.monthlyPremium, 0);
                  pricingResult.monthlyPremium = newTotalPremium;
                  pricingResult.employeeContribution = newTotalPremium;
                  
                  console.log(`💰 Recalculated bundle premium: $${newTotalPremium} (sum of ${pricingResult.includedProducts.length} components)`);
                }
              } else {
                // Regular product pricing
                pricingResult = await PricingEngine.calculateProductPricing(
                  productId,
                  memberCriteria,
                  configValues,
                  effectiveDate || null
                );
              }

              householdPremium = pricingResult.monthlyPremium || 0;
              console.log(`💰 Calculated household premium: $${householdPremium} for product ${product.Name}`);

              // Extract pricing details for enrollment snapshot
              pricingDetails = pricingResult.pricingDetails || {};
              console.log('📋 Pricing details for enrollment snapshot:', pricingDetails);

              // Validate frontend vs backend pricing
              if (frontendPricing && Array.isArray(frontendPricing)) {
                const frontendProduct = frontendPricing.find(fp => fp.productId === productId);
                if (frontendProduct) {
                  const frontendAmount = frontendProduct.monthlyPremium || 0;
                  const backendAmount = householdPremium;
                  const difference = Math.abs(frontendAmount - backendAmount);
                  const tolerance = 0.01; // 1 cent tolerance

                  if (difference > tolerance) {
                    console.error(`🚨 PRICING VALIDATION FAILED for ${product.Name}: Frontend $${frontendAmount.toFixed(2)} vs Backend $${backendAmount.toFixed(2)}`);
                    console.warn(`⚠️ WARNING: Using backend amount ($${backendAmount.toFixed(2)}) and proceeding with enrollment`);
                    console.warn(`⚠️ This pricing mismatch will be investigated - frontend pricing calculation needs fixing`);
                    // DON'T throw - use backend amount instead for now
                    // throw new Error(`Pricing validation failed for ${product.Name}. Frontend: $${frontendAmount.toFixed(2)}, Backend: $${backendAmount.toFixed(2)}`);
                  } else {
                    console.log(`✅ PRICING VALIDATION PASSED for ${product.Name}`);
                  }
                } else {
                  console.error(`🚨 SECURITY ALERT: No frontend pricing data found for product ${productId}`);
                  throw new Error(`No frontend pricing data found for ${product.Name}`);
                }
              } else {
                console.error(`🚨 SECURITY ALERT: No frontend pricing data provided for validation`);
                throw new Error('No frontend pricing data provided for validation');
              }

            } catch (pricingError) {
              console.error('❌ Error calculating pricing:', pricingError);
              throw pricingError;
            }
          } else {
            console.log(`⚠️ No primary member found for product ${productId}, using $0 premium`);
          }

          // Create enrollments for all household members
          for (const householdMember of allHouseholdMembers) {
            const isPrimaryMember = householdMember.RelationshipType === 'P';
            const premiumAmount = isPrimaryMember ? householdPremium : 0;

            console.log(`🔍 Processing ${householdMember.RelationshipType} member: ${householdMember.MemberId}, Premium: $${premiumAmount}`);

            // Check if enrollment already exists
            const existingEnrollmentQuery = `
              SELECT 
                e.EnrollmentId,
                e.Status,
                e.EffectiveDate,
                e.PremiumAmount
              FROM oe.Enrollments e
              WHERE e.MemberId = @memberId 
                AND e.ProductId = @productId
                AND e.Status IN ('Active', 'Pending')
            `;

            const existingEnrollmentRequest = transaction.request();
            existingEnrollmentRequest.input('memberId', sql.UniqueIdentifier, householdMember.MemberId);
            existingEnrollmentRequest.input('productId', sql.UniqueIdentifier, productId);

            const existingEnrollmentResult = await existingEnrollmentRequest.query(existingEnrollmentQuery);

            if (existingEnrollmentResult.recordset.length > 0) {
              // Update existing enrollment
              const existingEnrollment = existingEnrollmentResult.recordset[0];

              if (existingEnrollment.Status !== 'Active' || existingEnrollment.PremiumAmount !== premiumAmount) {
                // Calculate employer contribution for update
                let employerContributionForUpdate = 0;
                let contributionIdForUpdate = null;
                
                if (isPrimaryMember && member.GroupId) {
                  try {
                    contributionIdForUpdate = await this.getProductSpecificContributionRule(
                      member.GroupId, 
                      productId, 
                      new Date(effectiveDate), 
                      transaction
                    );
                    
                    const contributionResult = await ContributionCalculator.calculateContributions({
                      groupId: member.GroupId,
                      productPricingResults: [{
                        productId: productId,
                        productName: product.Name,
                        monthlyPremium: premiumAmount,
                        productType: product.ProductType || '',
                        isBundle: product.IsBundle || false
                      }],
                      memberCriteria
                    });
                    
                    const productContribution = contributionResult.productContributions[productId];
                    if (productContribution) {
                      employerContributionForUpdate = productContribution.productSpecific || 0;
                    }
                  } catch (error) {
                    console.error('❌ Error calculating contribution for update:', error);
                  }
                }
                
                const updateEnrollmentRequest = transaction.request();
                updateEnrollmentRequest.input('enrollmentId', sql.UniqueIdentifier, existingEnrollment.EnrollmentId);
                updateEnrollmentRequest.input('status', sql.NVarChar, 'Active');
                updateEnrollmentRequest.input('premiumAmount', sql.Decimal(19,4), premiumAmount);
                updateEnrollmentRequest.input('policyNumber', sql.NVarChar, product.VendorProductID);
                updateEnrollmentRequest.input('employerContribution', sql.Decimal(19,4), employerContributionForUpdate);
                updateEnrollmentRequest.input('contributionId', sql.UniqueIdentifier, contributionIdForUpdate);
                
                // Store configuration in enrollment details
                const enrollmentDetails = JSON.stringify({
                  configuration: productConfigValue || 'Default',
                  enrollmentType: 'product_change',
                  timestamp: new Date().toISOString()
                });
                updateEnrollmentRequest.input('enrollmentDetails', sql.NVarChar, enrollmentDetails);
                updateEnrollmentRequest.input('modifiedBy', sql.UniqueIdentifier, member.UserId);
                
                // Add HouseholdId (use from householdMember or member)
                const updateHouseholdId = householdMember.HouseholdId || member.HouseholdId || null;
                updateEnrollmentRequest.input('householdId', sql.UniqueIdentifier, updateHouseholdId);

                // Add pricing snapshot fields if pricing details are available (primary member only)
                if (pricingDetails && isPrimaryMember) {
                  updateEnrollmentRequest.input('productPricingId', sql.UniqueIdentifier, pricingDetails.productPricingId || null);
                  updateEnrollmentRequest.input('netRate', sql.Decimal(19,4), pricingDetails.netRate || 0);
                  updateEnrollmentRequest.input('overrideRate', sql.Decimal(19,4), pricingDetails.overrideRate || 0);
                  updateEnrollmentRequest.input('commission', sql.Decimal(19,4), pricingDetails.vendorCommission || 0);
                  updateEnrollmentRequest.input('systemFees', sql.Decimal(19,4), pricingDetails.systemFees || 0);
                } else {
                  // Non-primary members or no pricing details - don't update pricing fields
                  updateEnrollmentRequest.input('productPricingId', sql.UniqueIdentifier, null);
                  updateEnrollmentRequest.input('netRate', sql.Decimal(19,4), null);
                  updateEnrollmentRequest.input('overrideRate', sql.Decimal(19,4), null);
                  updateEnrollmentRequest.input('commission', sql.Decimal(19,4), null);
                  updateEnrollmentRequest.input('systemFees', sql.Decimal(19,4), null);
                }

                await updateEnrollmentRequest.query(`
                  UPDATE oe.Enrollments 
                  SET Status = @status,
                      PremiumAmount = @premiumAmount,
                      PolicyNumber = @policyNumber,
                      EnrollmentDetails = @enrollmentDetails,
                      EmployerContributionAmount = @employerContribution,
                      ContributionId = @contributionId,
                      HouseholdId = @householdId,
                      ProductPricingId = @productPricingId,
                      NetRate = @netRate,
                      OverrideRate = @overrideRate,
                      Commission = @commission,
                      SystemFees = @systemFees,
                      ModifiedDate = GETUTCDATE(),
                      ModifiedBy = @modifiedBy
                  WHERE EnrollmentId = @enrollmentId
                `);

                updatedEnrollments.push({
                  enrollmentId: existingEnrollment.EnrollmentId,
                  memberId: householdMember.MemberId,
                  memberName: `${householdMember.FirstName} ${householdMember.LastName}`,
                  productId,
                  premiumAmount,
                  action: 'updated',
                  previousStatus: existingEnrollment.Status,
                  newStatus: 'Active'
                });

                console.log(`✅ Updated existing enrollment: ${existingEnrollment.EnrollmentId}`);
              }
            } else {
              // Create new enrollment
              const enrollmentId = crypto.randomUUID();
              const enrollmentEffectiveDate = effectiveDate ? new Date(effectiveDate) : new Date();

              // Calculate employer contribution for primary members only
              let contributionId = null;
              let employerContribution = 0;
              
              if (isPrimaryMember && member.GroupId) {
                try {
                  // Look up product-specific contribution rule
                  contributionId = await this.getProductSpecificContributionRule(
                    member.GroupId, 
                    productId, 
                    enrollmentEffectiveDate, 
                    transaction
                  );
                  
                  // Calculate employer contribution using ContributionCalculator
                  const contributionResult = await ContributionCalculator.calculateContributions({
                    groupId: member.GroupId,
                    productPricingResults: [{
                      productId: productId,
                      productName: product.Name,
                      monthlyPremium: householdPremium,
                      productType: product.ProductType || '',
                      isBundle: product.IsBundle || false
                    }],
                    memberCriteria
                  });
                  
                  // Get product-specific contribution ONLY (not all-products share)
                  const productContribution = contributionResult.productContributions[productId];
                  if (productContribution) {
                    employerContribution = productContribution.productSpecific || 0;
                    console.log(`💰 Employer contribution for ${product.Name}: $${employerContribution.toFixed(2)} (Rule: ${contributionId || 'None'})`);
                  }
                } catch (error) {
                  console.error('❌ Error calculating contribution:', error);
                  // Continue without contribution if calculation fails
                }
              }

              const createEnrollmentRequest = transaction.request();
              createEnrollmentRequest.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
              createEnrollmentRequest.input('memberId', sql.UniqueIdentifier, householdMember.MemberId);
              createEnrollmentRequest.input('productId', sql.UniqueIdentifier, productId);
              createEnrollmentRequest.input('agentId', sql.UniqueIdentifier, householdMember.AgentId);
              createEnrollmentRequest.input('policyNumber', sql.NVarChar, product.VendorProductID);
              createEnrollmentRequest.input('effectiveDate', sql.Date, enrollmentEffectiveDate);
              createEnrollmentRequest.input('premiumAmount', sql.Decimal(19,4), premiumAmount);
              createEnrollmentRequest.input('paymentFrequency', sql.NVarChar, 'Monthly');
              
              // Add HouseholdId (use from householdMember or member)
              const enrollmentHouseholdId = householdMember.HouseholdId || member.HouseholdId || null;
              createEnrollmentRequest.input('householdId', sql.UniqueIdentifier, enrollmentHouseholdId);
              
              // Store configuration in enrollment details as JSON
              const enrollmentDetails = JSON.stringify({
                configuration: productConfigValue || 'Default',
                enrollmentType: 'product_change',
                timestamp: new Date().toISOString(),
                tier: memberCriteria.tier,
                tobaccoUse: memberCriteria.tobaccoUse
              });
              createEnrollmentRequest.input('enrollmentDetails', sql.NVarChar, enrollmentDetails);
              createEnrollmentRequest.input('createdBy', sql.UniqueIdentifier, member.UserId);
              createEnrollmentRequest.input('employerContribution', sql.Decimal(19,4), employerContribution);
              createEnrollmentRequest.input('contributionId', sql.UniqueIdentifier, contributionId);

              // Add pricing snapshot fields if pricing details are available (primary member only)
              if (pricingDetails && isPrimaryMember) {
                createEnrollmentRequest.input('productPricingId', sql.UniqueIdentifier, pricingDetails.productPricingId || null);
                createEnrollmentRequest.input('netRate', sql.Decimal(19,4), pricingDetails.netRate || 0);
                createEnrollmentRequest.input('overrideRate', sql.Decimal(19,4), pricingDetails.overrideRate || 0);
                createEnrollmentRequest.input('commission', sql.Decimal(19,4), pricingDetails.vendorCommission || 0);
                createEnrollmentRequest.input('systemFees', sql.Decimal(19,4), pricingDetails.systemFees || 0);
              } else {
                // Non-primary members or no pricing details - set to 0/NULL
                createEnrollmentRequest.input('productPricingId', sql.UniqueIdentifier, null);
                createEnrollmentRequest.input('netRate', sql.Decimal(19,4), 0);
                createEnrollmentRequest.input('overrideRate', sql.Decimal(19,4), 0);
                createEnrollmentRequest.input('commission', sql.Decimal(19,4), 0);
                createEnrollmentRequest.input('systemFees', sql.Decimal(19,4), 0);
              }

              // Always include EmployerContributionAmount and ContributionId fields
              const insertFields = [
                'EnrollmentId', 'MemberId', 'ProductId', 'AgentId', 'PolicyNumber', 'Status', 'EffectiveDate',
                'PremiumAmount', 'PaymentFrequency', 'EnrollmentDetails',
                'EmployerContributionAmount', 'ContributionId',
                'HouseholdId', 'ProductPricingId', 'NetRate', 'OverrideRate', 'Commission', 'SystemFees',
                'CreatedDate', 'ModifiedDate', 'CreatedBy', 'ModifiedBy'
              ];
              const insertValues = [
                '@enrollmentId', '@memberId', '@productId', '@agentId', '@policyNumber', "'Pending'", '@effectiveDate',
                '@premiumAmount', '@paymentFrequency', '@enrollmentDetails',
                '@employerContribution', '@contributionId',
                '@householdId', '@productPricingId', '@netRate', '@overrideRate', '@commission', '@systemFees',
                'GETUTCDATE()', 'GETUTCDATE()', '@createdBy', '@createdBy'
              ];

              await createEnrollmentRequest.query(`
                INSERT INTO oe.Enrollments 
                (${insertFields.join(', ')})
                VALUES 
                (${insertValues.join(', ')})
              `);

              createdEnrollments.push({
                enrollmentId,
                memberId: householdMember.MemberId,
                memberName: `${householdMember.FirstName} ${householdMember.LastName}`,
                productId,
                premiumAmount,
                effectiveDate: enrollmentEffectiveDate.toISOString().split('T')[0],
                action: 'created'
              });

              console.log(`✅ Created new enrollment: ${enrollmentId} for ${householdMember.RelationshipType} member ${householdMember.FirstName} ${householdMember.LastName} with premium $${premiumAmount}`);
            }
          }

        } catch (productError) {
          console.error(`❌ Error processing product ${productId}:`, productError);
          
          // For pricing validation errors, fail immediately - don't continue processing
          if (productError.message && productError.message.includes('Pricing validation failed')) {
            console.error('🚨 CRITICAL: Pricing validation failed - aborting enrollment');
            throw productError; // Re-throw to stop processing immediately
          }
          
          // For other errors, collect them (but we should probably fail immediately for all errors)
          errors.push({
            productId,
            error: productError.message
          });
        }
      }

      // ==================================================================================
      // CREATE SEPARATE ENROLLMENT ROWS FOR ALL-PRODUCTS CONTRIBUTION RULES
      // ==================================================================================
      // Only for primary member in groups with all-products rules
      if (member.GroupId) {
        const primaryMember = allHouseholdMembers.find(m => m.RelationshipType === 'P');
        
        if (primaryMember) {
          console.log('🔍 Creating all-products contribution enrollment rows...');
          
          // Get all-products contribution rules (ProductId IS NULL)
          const allProductsRulesQuery = `
            SELECT 
              gc.ContributionId,
              gc.Name,
              gc.ContributionType,
              gc.ContributionDirection,
              gc.FlatRateAmount,
              gc.PercentageAmount,
              gc.TierContributions,
              gc.Priority
            FROM oe.GroupContributions gc
            WHERE gc.GroupId = @groupId 
              AND gc.ProductId IS NULL 
              AND gc.Status = 'Active'
              AND gc.EffectiveDate <= @effectiveDate
              AND (gc.EndDate IS NULL OR gc.EndDate >= @effectiveDate)
            ORDER BY gc.Priority
          `;
          
          const allProductsRequest = transaction.request();
          allProductsRequest.input('groupId', sql.UniqueIdentifier, member.GroupId);
          allProductsRequest.input('effectiveDate', sql.Date, effectiveDate ? new Date(effectiveDate) : new Date());
          const allProductsResult = await allProductsRequest.query(allProductsRulesQuery);
          
          console.log(`🔍 Found ${allProductsResult.recordset.length} all-products contribution rules`);
          
          // Calculate total premium for all selected products
          let totalPremium = 0;
          const productPricingResults = [];
          if (frontendPricing && Array.isArray(frontendPricing)) {
            for (const productId of selectedProducts) {
              const frontendProduct = frontendPricing.find(fp => fp.productId === productId);
              if (frontendProduct) {
                totalPremium += frontendProduct.monthlyPremium || 0;
                productPricingResults.push({
                  productId: productId,
                  monthlyPremium: frontendProduct.monthlyPremium || 0,
                  productName: frontendProduct.productName || 'Unknown Product'
                });
              }
            }
          }
          
          console.log(`💰 Total premium for all products: $${totalPremium.toFixed(2)}`);
          
          // CRITICAL: Use ContributionCalculator to calculate all-products contribution
          // This ensures MaxEmployee rules correctly include fees in the calculation
          // We need to calculate fees first to pass to ContributionCalculator
          let additionalFees = 0;
          try {
            // Get tenant settings for fee calculation
            const tenantSettingsQuery = `
              SELECT PaymentProcessorSettings, SystemFees
              FROM oe.Tenants 
              WHERE TenantId = @tenantId
            `;
            const tenantSettingsRequest = transaction.request();
            tenantSettingsRequest.input('tenantId', sql.UniqueIdentifier, member.TenantId);
            const tenantSettingsResult = await tenantSettingsRequest.query(tenantSettingsQuery);
            
            if (tenantSettingsResult.recordset.length > 0) {
              let paymentProcessorSettings = null;
              let systemFeesSettings = null;
              
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
              
              // Calculate system fees
              const systemFeesCalculator = require('../utils/systemFeesCalculator');
              const systemFeesAmount = systemFeesCalculator.calculateSystemFees(
                totalPremium,
                systemFeesSettings
              );
              
              // Calculate processing fees (need payment method for group)
              let groupPaymentMethod = 'ACH'; // Default to ACH
              const groupPaymentMethodQuery = `
                SELECT TOP 1 Type FROM oe.GroupPaymentMethods 
                WHERE GroupId = @groupId AND Status = 'Active' 
                ORDER BY IsDefault DESC, CreatedDate DESC
              `;
              const groupPaymentMethodRequest = transaction.request();
              groupPaymentMethodRequest.input('groupId', sql.UniqueIdentifier, member.GroupId);
              const groupPaymentMethodResult = await groupPaymentMethodRequest.query(groupPaymentMethodQuery);
              
              if (groupPaymentMethodResult.recordset.length > 0) {
                groupPaymentMethod = groupPaymentMethodResult.recordset[0].Type === 'CreditCard' ? 'Card' : 'ACH';
              }
              
              // Phase 3: fee math via pricingAuthority (single source of truth).
              // Authority returns total = included (Highest) + non-included (member method).
              const pricingAuthority = require('./pricing/pricingAuthority.service');
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
              let paymentProcessingFeeAmount = 0;
              if (pricingProductsForAuth.length > 0) {
                const authorityOutput = await pricingAuthority.computePricing({
                  poolOrTransaction: transaction,
                  tenantId: member.TenantId,
                  pricingProducts: pricingProductsForAuth,
                  paymentMethodType: groupPaymentMethod
                });
                paymentProcessingFeeAmount =
                  Number(authorityOutput.totals.includedFeeTotal || 0) +
                  Number(authorityOutput.totals.nonIncludedFeeTotal || 0);
              }

              additionalFees = systemFeesAmount + paymentProcessingFeeAmount;
              console.log(`💳 Calculated additional fees for contribution: $${additionalFees.toFixed(2)} (System: $${systemFeesAmount.toFixed(2)}, Processing: $${paymentProcessingFeeAmount.toFixed(2)})`);
            }
          } catch (feeError) {
            console.warn('⚠️ Error calculating fees for contribution (non-fatal):', feeError);
            // Continue with fees = 0 if calculation fails
          }
          
          // Use ContributionCalculator to get the correct all-products contribution
          // This ensures MaxEmployee rules include fees correctly
          // CRITICAL: Use calculatedTier (from request) instead of member.Tier (from DB) to ensure correct tier is used
          let allProductsContributionAmount = 0;
          try {
            // Use the same tier/tobacco logic as pricing calculations
            const tierToUseForContributions = calculatedTier || member.Tier || 'EE';
            const tobaccoToUseForContributions = newTobaccoUse || (member.TobaccoUse === 'Y' ? 'Yes' : 'No');
            
            const contributionResult = await ContributionCalculator.calculateContributions({
              groupId: member.GroupId,
              productPricingResults: productPricingResults,
              memberCriteria: {
                age: getMemberAgeForPricing(member.DateOfBirth, 35),
                tier: tierToUseForContributions,
                tobaccoUse: tobaccoToUseForContributions,
                jobPosition: member.JobPosition || null,
                householdSize: allHouseholdMembers.length
              },
              additionalFees: additionalFees // Pass fees to include in MaxEmployee calculation
            });
            
            allProductsContributionAmount = contributionResult.allProductsContribution || 0;
            console.log(`💰 All-products contribution (from ContributionCalculator): $${allProductsContributionAmount.toFixed(2)}`);
          } catch (contribError) {
            console.error('❌ Error calculating all-products contribution with ContributionCalculator:', contribError);
            // Fall back to manual calculation (without fees) for backward compatibility
            console.warn('⚠️ Falling back to manual calculation (without fees)');
            allProductsContributionAmount = 0;
            
            // Manual calculation fallback (doesn't include fees - incorrect for MaxEmployee)
            for (const rule of allProductsResult.recordset) {
              let ruleContributionAmount = 0;
              const direction = rule.ContributionDirection || 'Employer';
              
              if (rule.ContributionType === 'flat_rate') {
                ruleContributionAmount = Number(rule.FlatRateAmount) || 0;
              } else if (rule.ContributionType === 'percentage') {
                const percentage = Number(rule.PercentageAmount) || 0;
                ruleContributionAmount = totalPremium * (percentage / 100);
              } else if (rule.ContributionType === 'tier_based') {
                const tier = member.Tier || 'EE';
                const tierContributions = rule.TierContributions ? JSON.parse(rule.TierContributions) : {};
                ruleContributionAmount = tierContributions[tier] || tierContributions.employee_only || tierContributions.employee_spouse || tierContributions.employee_children || tierContributions.family || tierContributions.employee_family || 0;
              }
              
              if (direction === 'MaxEmployee') {
                const maxEmployeeAmount = Math.min(ruleContributionAmount, totalPremium);
                ruleContributionAmount = Math.max(0, totalPremium - maxEmployeeAmount);
              }
              
              allProductsContributionAmount += ruleContributionAmount;
            }
          }
          
          // Create enrollment row for all-products contribution (one row total, not per rule)
          // Use the first rule's ContributionId for tracking
          const firstRule = allProductsResult.recordset[0];
          if (firstRule && allProductsContributionAmount > 0) {
            console.log(`💰 Creating all-products contribution row: ${firstRule.Name} = $${allProductsContributionAmount.toFixed(2)}`);
            
            const allProductsEnrollmentId = crypto.randomUUID();
            const allProductsInsertRequest = transaction.request();
            
            allProductsInsertRequest.input('enrollmentId', sql.UniqueIdentifier, allProductsEnrollmentId);
            allProductsInsertRequest.input('memberId', sql.UniqueIdentifier, primaryMember.MemberId);
            allProductsInsertRequest.input('productId', sql.UniqueIdentifier, '00000000-0000-0000-0000-000000000000');  // Special "All Products" GUID
            allProductsInsertRequest.input('agentId', sql.UniqueIdentifier, primaryMember.AgentId);
            allProductsInsertRequest.input('effectiveDate', sql.Date, effectiveDate ? new Date(effectiveDate) : new Date());
            allProductsInsertRequest.input('premiumAmount', sql.Decimal(19,4), 0);  // No premium for virtual enrollment
            allProductsInsertRequest.input('employerContribution', sql.Decimal(19,4), allProductsContributionAmount);
            allProductsInsertRequest.input('contributionId', sql.UniqueIdentifier, firstRule.ContributionId);
            allProductsInsertRequest.input('paymentFrequency', sql.NVarChar, 'Monthly');
            allProductsInsertRequest.input('enrollmentDetails', sql.NVarChar, JSON.stringify({
              enrollmentType: 'all_products_contribution',
              ruleName: firstRule.Name,
              ruleType: firstRule.ContributionType,
              contributionDirection: firstRule.ContributionDirection || 'Employer',
              employerContributionAmount: allProductsContributionAmount,
              totalPremiumAtEnrollment: totalPremium,
              additionalFeesIncluded: additionalFees, // Store that fees were included in calculation
              timestamp: new Date().toISOString()
            }));
            allProductsInsertRequest.input('createdBy', sql.UniqueIdentifier, member.UserId);
            
            await allProductsInsertRequest.query(`
              INSERT INTO oe.Enrollments 
              (EnrollmentId, MemberId, ProductId, AgentId, Status, EffectiveDate,
               PremiumAmount, PaymentFrequency, EnrollmentDetails, 
               EmployerContributionAmount, ContributionId, EnrollmentType,
               CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
              VALUES 
              (@enrollmentId, @memberId, @productId, @agentId, 'Active', @effectiveDate,
               @premiumAmount, @paymentFrequency, @enrollmentDetails,
               @employerContribution, @contributionId, 'Contribution',
               GETUTCDATE(), GETUTCDATE(), @createdBy, @createdBy)
            `);
            
            createdEnrollments.push({
              enrollmentId: allProductsEnrollmentId,
              memberId: primaryMember.MemberId,
              memberName: `${primaryMember.FirstName} ${primaryMember.LastName}`,
              productId: '00000000-0000-0000-0000-000000000000',  // Special "All Products" GUID
              premiumAmount: 0,
              employerContribution: allProductsContributionAmount,
              contributionRuleName: firstRule.Name,
              effectiveDate: effectiveDate ? new Date(effectiveDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
              action: 'created',
              type: 'all_products_contribution'
            });
            
            console.log(`✅ Created all-products contribution enrollment: ${allProductsEnrollmentId} for rule "${firstRule.Name}" - Employer: $${allProductsContributionAmount.toFixed(2)} (includes fees: $${additionalFees.toFixed(2)})`);
          }
        }
      }

      // Generate PDF if acknowledgements and signature are provided
      let pdfUrl = null;
      if (acknowledgements && acknowledgements.length > 0 && digitalSignature) {
        console.log('📄 Generating agreements PDF with acknowledgements and signature...');
        
        try {
          // Fetch full product details for PDF generation
          const productDetailsForPDF = [];
          for (const productId of selectedProducts) {
            const productQuery = `
              SELECT 
                p.ProductId,
                p.Name,
                p.VendorProductID
              FROM oe.Products p
              WHERE p.ProductId = @productId
            `;
            
            const productRequest = transaction.request();
            productRequest.input('productId', sql.UniqueIdentifier, productId);
            const productResult = await productRequest.query(productQuery);
            
            if (productResult.recordset.length > 0) {
              const product = productResult.recordset[0];
              productDetailsForPDF.push({
                productId: product.ProductId,
                name: product.Name,
                productName: product.Name, // Also include as productName for compatibility
                vendorProductId: product.VendorProductID
              });
            }
          }
          
          console.log('🔍 Product details for PDF:', productDetailsForPDF);
          console.log('🔍 Acknowledgements for PDF:', acknowledgements);
          console.log('🔍 Member info for PDF:', memberInfo);
          
          const pdfBase64 = await generateAgreementsPDF(acknowledgements, digitalSignature, memberInfo, productDetailsForPDF);
          
          // Convert base64 to Buffer for Azure upload
          const pdfBuffer = Buffer.from(pdfBase64, 'base64');
          
          // Create a file object for Azure upload
          const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
          const filename = `enrollment-agreements-${timestamp}.pdf`;
          const blobName = `users/${member.UserId}/${filename}`;
          
          // Import Azure upload functions
          const { uploadToAzureBlob, generateAuthenticatedUrl } = require('../routes/uploads');
          
          // Create file object for upload
          const fileObject = {
            buffer: pdfBuffer,
            originalname: filename,
            mimetype: 'application/pdf',
            size: pdfBuffer.length
          };
          
          // Upload to Azure Blob Storage
          console.log(`📄 Uploading PDF to Azure: ${blobName}`);
          const uploadedUrl = await uploadToAzureBlob(fileObject, 'documents', blobName);
          
          // Generate authenticated URL for frontend access
          console.log(`🔐 Generating authenticated URL for PDF`);
          pdfUrl = await generateAuthenticatedUrl(uploadedUrl);
          
          console.log(`✅ PDF uploaded and authenticated: ${pdfUrl}`);
          
          // Store the PDF link in the member's SignedAgreements field (skip this for now to avoid transaction conflicts)
          // TODO: Move this outside the transaction or refactor to use transaction properly
          console.log(`⚠️ Skipping SignedAgreements update (will be handled post-transaction)`);
          
        } catch (pdfError) {
          console.error('❌ Error generating or uploading PDF:', pdfError);
          throw new Error(`PDF generation failed: ${pdfError.message}`);
        }
      } else {
        console.log('⚠️ No acknowledgements or digital signature provided - proceeding without PDF generation');
      }

      return {
        success: true,
        data: {
          createdEnrollments,
          updatedEnrollments,
          pdfUrl,
          totalCreated: createdEnrollments.length,
          totalUpdated: updatedEnrollments.length,
          errors: errors.length > 0 ? errors : null
        }
      };

    } catch (error) {
      console.error('❌ EnrollmentCompletionService error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get acknowledgements for selected products
   * @param {Array} productIds - Array of product IDs
   * @returns {Promise<Object>} - Product acknowledgements
   */
  static async getProductAcknowledgements(productIds) {
    try {
      const pool = await getPool();

      if (!productIds || productIds.length === 0) {
        return {
          success: true,
          data: {
            productAcknowledgements: [],
            totalProducts: 0,
            productsWithAcknowledgements: 0
          }
        };
      }

      // Get acknowledgements for selected products AND products included in selected bundles
      const acknowledgementsQuery = `
        SELECT 
          p.ProductId,
          p.Name AS ProductName,
          p.ProductType,
          p.AcknowledgementQuestions,
          'Direct' AS SelectionType
        FROM oe.Products p
        WHERE p.ProductId IN (${productIds.map((_, index) => `@product${index}`).join(',')})
          AND p.Status = 'Active'
        
        UNION ALL
        
        SELECT 
          p.ProductId,
          p.Name AS ProductName,
          p.ProductType,
          p.AcknowledgementQuestions,
          'Bundle' AS SelectionType
        FROM oe.Products p
        INNER JOIN oe.ProductBundles pb ON p.ProductId = pb.IncludedProductId
        WHERE pb.BundleProductId IN (${productIds.map((_, index) => `@product${index}`).join(',')})
          AND p.Status = 'Active'
      `;

      const acknowledgementsRequest = pool.request();
      productIds.forEach((id, index) => {
        acknowledgementsRequest.input(`product${index}`, sql.UniqueIdentifier, id);
      });

      const acknowledgementsResult = await acknowledgementsRequest.query(acknowledgementsQuery);

      // Process acknowledgements (avoid duplicates)
      const productAcknowledgements = [];
      const processedProductIds = new Set();

      for (const product of acknowledgementsResult.recordset) {
        if (processedProductIds.has(product.ProductId)) {
          continue;
        }

        let acknowledgements = [];

        if (product.AcknowledgementQuestions) {
          try {
            acknowledgements = JSON.parse(product.AcknowledgementQuestions);
          } catch (parseError) {
            console.log(`⚠️ Could not parse acknowledgements for ${product.ProductName}:`, parseError.message);
            acknowledgements = [];
          }
        }

        if (acknowledgements.length > 0) {
          productAcknowledgements.push({
            productId: product.ProductId,
            productName: product.ProductName,
            productType: product.ProductType,
            selectionType: product.SelectionType,
            acknowledgements: acknowledgements.map((ack) => ({
              id: ack.id,
              question: ack.question,
              fieldType: ack.fieldType,
              required: ack.required,
              options: ack.options || [],
              customAction: ack.customAction || null
            }))
          });

          processedProductIds.add(product.ProductId);
        }
      }

      return {
        success: true,
        data: {
          productAcknowledgements,
          totalProducts: productIds.length,
          productsWithAcknowledgements: productAcknowledgements.length
        }
      };

    } catch (error) {
      console.error('❌ Error getting product acknowledgements:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

// Helper function to update member's signed agreements
async function updateMemberSignedAgreements(memberId, pdfUrl, timestamp) {
  try {
    const pool = await getPool();
    
    // Use a single query to handle both insert and update cases efficiently
    const request = pool.request();
    request.input('memberId', sql.UniqueIdentifier, memberId);
    request.input('pdfUrl', sql.NVarChar, pdfUrl);
    request.input('timestamp', sql.NVarChar, timestamp);
    request.input('newAgreement', sql.NVarChar, JSON.stringify({
      url: pdfUrl,
      timestamp: timestamp,
      generatedDate: new Date().toISOString(),
      type: 'product_change_agreements'
    }));
    
    // First, ensure the SignedAgreements column exists (only check once per session)
    if (!global.signedAgreementsColumnExists) {
      try {
        const checkResult = await pool.request().query(`
          SELECT COLUMN_NAME 
          FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_NAME = 'Members' 
          AND COLUMN_NAME = 'SignedAgreements'
        `);
        
        if (checkResult.recordset.length === 0) {
          console.log('🔧 Adding SignedAgreements field to Members table');
          await pool.request().query(`
            ALTER TABLE oe.Members 
            ADD SignedAgreements NVARCHAR(MAX)
          `);
        }
        global.signedAgreementsColumnExists = true;
      } catch (error) {
        console.warn('⚠️ Could not check/add SignedAgreements column:', error.message);
        // Continue anyway - the column might already exist
      }
    }
    
    // Get existing agreements first
    const existingResult = await request.query(`
      SELECT ISNULL(SignedAgreements, '[]') as SignedAgreements
      FROM oe.Members 
      WHERE MemberId = @memberId
    `);
    
    let existingAgreements = [];
    if (existingResult.recordset.length > 0 && existingResult.recordset[0].SignedAgreements) {
      try {
        existingAgreements = JSON.parse(existingResult.recordset[0].SignedAgreements);
      } catch (error) {
        console.warn('⚠️ Failed to parse existing SignedAgreements, starting fresh');
        existingAgreements = [];
      }
    }
    
    // Add new agreement
    const newAgreement = {
      url: pdfUrl,
      timestamp: timestamp,
      generatedDate: new Date().toISOString(),
      type: 'product_change_agreements'
    };
    
    existingAgreements.push(newAgreement);
    
    // Update the record with the new agreements array
    const updateRequest = pool.request();
    updateRequest.input('memberId', sql.UniqueIdentifier, memberId);
    updateRequest.input('signedAgreements', sql.NVarChar, JSON.stringify(existingAgreements));
    
    await updateRequest.query(`
      UPDATE oe.Members 
      SET SignedAgreements = @signedAgreements,
          ModifiedDate = GETUTCDATE()
      WHERE MemberId = @memberId
    `);
    
    console.log('✅ Member signed agreements updated successfully');
    
  } catch (error) {
    console.error('❌ Error updating member signed agreements:', error);
    throw error;
  }
}

module.exports = { EnrollmentCompletionService };
