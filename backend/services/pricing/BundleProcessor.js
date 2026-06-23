/**
 * BUNDLE PROCESSOR - Handle bundle products and their included products
 * 
 * Used by: PricingEngine for processing bundle products
 */

const { getPool, sql } = require('../../config/database');

class BundleProcessor {
  /**
   * Process bundle product and calculate pricing for all included products
   * @param {string} bundleProductId - Bundle product ID
   * @param {Object} memberCriteria - Member criteria for pricing
   * @param {Object} configValues - Configuration values for included products
   * @param {string} effectiveDate - Effective date for pricing (YYYY-MM-DD format)
   * @returns {Object} Bundle pricing result
   */
  static async processBundleProduct(bundleProductId, memberCriteria, configValues = {}, effectiveDate = null, options = {}) {
    try {
      // 1. Get all included products in the bundle
      const includedProducts = await this.getBundleIncludedProducts(bundleProductId);
      
      console.log(`🔍 DEBUG: Bundle ${bundleProductId} has ${includedProducts?.length || 0} included products:`, 
        includedProducts?.map(p => ({ name: p.productName, id: p.productId, sortOrder: p.sortOrder })));
      
      if (!includedProducts || includedProducts.length === 0) {
        throw new Error(`No included products found for bundle: ${bundleProductId}`);
      }

      // 2. Calculate pricing for each included product
      const includedPricingResults = [];
      let totalBundlePremium = 0;
      let totalBundleDiscount = 0;

      for (const includedProduct of includedProducts) {
        try {
          console.log(`🔍 DEBUG: Processing included product ${includedProduct.productName} (${includedProduct.productId})`);
          
          // Pass the bundle-level configValues directly (contains configValue1, etc.)
          // Don't try to index by product ID - the config is shared across all included products
          const productPricing = await this.calculateIncludedProductPricing(
            includedProduct.productId,
            memberCriteria,
            configValues,  // Pass entire configValues object
            effectiveDate,  // Pass effective date for pricing filtering
            options
          );

          console.log(`✅ DEBUG: Successfully processed ${includedProduct.productName}: $${productPricing.monthlyPremium} (type: ${typeof productPricing.monthlyPremium})`);

          includedPricingResults.push({
            ...productPricing,
            sortOrder: includedProduct.sortOrder
          });

          // CRITICAL: Ensure monthlyPremium is a number to prevent string concatenation
          const premiumToAdd = Number(productPricing.monthlyPremium || 0);
          console.log(`🔍 DEBUG: Adding $${premiumToAdd} to bundle total (current: $${totalBundlePremium})`);
          totalBundlePremium += premiumToAdd;
          console.log(`🔍 DEBUG: New bundle total: $${totalBundlePremium}`);
        } catch (error) {
          console.error(`❌ Error calculating pricing for included product ${includedProduct.productId} (${includedProduct.productName}):`, error);
          console.error(`❌ Error details:`, {
            message: error.message,
            stack: error.stack,
            productId: includedProduct.productId,
            productName: includedProduct.productName,
            memberCriteria: memberCriteria
          });
          // Continue with other products even if one fails
        }
      }

      // 3. Apply bundle-specific discounts if any
      const bundleDiscount = await this.getBundleDiscount(bundleProductId, memberCriteria);
      totalBundleDiscount = bundleDiscount;

      console.log(`🔍 DEBUG: Bundle totals before discount - Premium: $${totalBundlePremium}, Discount: $${totalBundleDiscount}`);

      // 4. Calculate final bundle premium
      const finalBundlePremium = Math.max(0, totalBundlePremium - totalBundleDiscount);
      
      console.log(`🔍 DEBUG: Final bundle premium for ${bundleProductId.substring(0, 8)}: $${finalBundlePremium}`);

      // 5. Distribute discount proportionally among included products
      const adjustedIncludedResults = this.distributeBundleDiscount(
        includedPricingResults,
        totalBundleDiscount
      );

      // 6. Check if any included products have configuration fields
      const configurableProducts = adjustedIncludedResults.filter(product => 
        product.hasConfigurationFields && product.availableConfigs && product.availableConfigs.length > 0
      );

      // 7. Create bundle configuration fields if any included products are configurable
      let bundleConfigFields = {
        hasConfigurationFields: configurableProducts.length > 0,
        availableConfigs: [],
        requiredDataFields: [],
        defaultConfig: null,
        pricingVariations: []
      };

      if (configurableProducts.length > 0) {
        // Use the first configurable product's configuration as the bundle configuration
        const firstConfigurable = configurableProducts[0];
        bundleConfigFields.availableConfigs = firstConfigurable.availableConfigs || [];
        bundleConfigFields.requiredDataFields = firstConfigurable.requiredDataFields || [];
        bundleConfigFields.defaultConfig = firstConfigurable.defaultConfig || (firstConfigurable.availableConfigs?.[0] || null);

        // Create pricing variations for the bundle based on included product configurations
        if (firstConfigurable.pricingVariations && firstConfigurable.pricingVariations.length > 0) {
          bundleConfigFields.pricingVariations = firstConfigurable.pricingVariations.map(variation => {
            // Calculate the bundle total for this configuration
            // We need to recalculate the bundle total with this specific configuration
            let configBundleTotal = 0;

            // Add all non-configurable products at their base price AND
            // other configurable products at their current base price
            adjustedIncludedResults.forEach(product => {
              if (!product.hasConfigurationFields) {
                // Non-configurable product — always add at base price
                configBundleTotal += Number(product.monthlyPremium || 0);
              } else if (product !== firstConfigurable) {
                // Other configurable products — add at their already-calculated base price
                // so they are not silently dropped from the bundle total
                configBundleTotal += Number(product.monthlyPremium || 0);
              }
            });

            // Add the first configurable product's price for this specific configuration
            // CRITICAL: Ensure monthlyPremium is a number to prevent string concatenation
            configBundleTotal += Number(variation.monthlyPremium || 0);

            return {
              configValue: variation.configValue,
              // CRITICAL: Ensure all pricing values are numbers
              monthlyPremium: Number(configBundleTotal),
              employerContribution: 0,
              employeeContribution: Number(configBundleTotal),
              netRate: 0,
              overrideRate: 0,
              msrpRate: 0,
              tierType: memberCriteria.tier,
              tobaccoStatus: memberCriteria.tobaccoUse
            };
          });
        }
      }

      return {
        productId: bundleProductId,
        isBundle: true,
        // CRITICAL: Ensure all pricing values are numbers
        monthlyPremium: Number(finalBundlePremium),
        originalPremium: Number(totalBundlePremium),
        bundleDiscount: Number(totalBundleDiscount),
        includedProducts: adjustedIncludedResults,
        memberCriteria,
        calculatedAt: new Date().toISOString(),
        // Add configuration fields for frontend compatibility
        ...bundleConfigFields
      };

    } catch (error) {
      console.error(`Error processing bundle product ${bundleProductId}:`, error);
      throw new Error(`Failed to process bundle product: ${error.message}`);
    }
  }

  /**
   * Get all included products in a bundle
   * @param {string} bundleProductId - Bundle product ID
   * @returns {Array} Array of included product objects
   */
  static async getBundleIncludedProducts(bundleProductId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('bundleProductId', sql.UniqueIdentifier, bundleProductId);

      const result = await request.query(`
        SELECT 
          pb.IncludedProductId as productId,
          pb.SortOrder as sortOrder,
          p.Name as productName,
          p.ProductType,
          p.IsBundle as isIncludedBundle
        FROM oe.ProductBundles pb
        INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
        WHERE pb.BundleProductId = @bundleProductId
          AND p.Status = 'Active'
        ORDER BY pb.SortOrder, p.Name
      `);

      return result.recordset.map(row => ({
        productId: row.productId,
        sortOrder: row.sortOrder || 0,
        productName: row.productName,
        productType: row.productType,
        isIncludedBundle: row.isIncludedBundle
      }));

    } catch (error) {
      console.error(`Error fetching bundle included products for ${bundleProductId}:`, error);
      throw new Error(`Failed to fetch bundle included products: ${error.message}`);
    }
  }

  /**
   * Get bundle-specific discount
   * @param {string} bundleProductId - Bundle product ID
   * @param {Object} memberCriteria - Member criteria
   * @returns {number} Bundle discount amount
   */
  static async getBundleDiscount(bundleProductId, memberCriteria) {
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('bundleProductId', sql.UniqueIdentifier, bundleProductId);

      // Look for bundle-specific discount rules
      // Note: Discount columns may not exist in all database schemas
      const result = await request.query(`
        SELECT 
          ProductId,
          Name,
          IsBundle,
          Status
        FROM oe.Products
        WHERE ProductId = @bundleProductId
          AND IsBundle = 1
          AND Status = 'Active'
      `);

      if (result.recordset.length === 0) {
        return 0;
      }

      const bundle = result.recordset[0];
      
      // For now, return 0 discount since discount columns don't exist in the current schema
      // TODO: Implement discount functionality when discount columns are added to the database
      console.log(`Bundle ${bundle.Name} found, but discount functionality is not available in current schema`);
      return 0;

    } catch (error) {
      console.error(`Error fetching bundle discount for ${bundleProductId}:`, error);
      return 0; // Return 0 discount on error
    }
  }

  /**
   * Distribute bundle discount proportionally among included products
   * @param {Array} includedResults - Included product pricing results
   * @param {number} totalDiscount - Total discount to distribute
   * @returns {Array} Adjusted pricing results with distributed discount
   */
  static distributeBundleDiscount(includedResults, totalDiscount) {
    if (totalDiscount <= 0 || includedResults.length === 0) {
      return includedResults;
    }

    const totalOriginalPremium = includedResults.reduce((sum, product) => sum + product.monthlyPremium, 0);
    
    if (totalOriginalPremium <= 0) {
      return includedResults;
    }

    return includedResults.map(product => {
      const proportion = Number(product.monthlyPremium) / totalOriginalPremium;
      const productDiscount = totalDiscount * proportion;
      const adjustedPremium = Math.max(0, Number(product.monthlyPremium) - productDiscount);

      return {
        ...product,
        // CRITICAL: Ensure all pricing values are numbers
        monthlyPremium: Number(adjustedPremium),
        originalPremium: Number(product.monthlyPremium),
        bundleDiscount: Number(productDiscount)
      };
    });
  }

  /**
   * Check if a product is a bundle
   * @param {string} productId - Product ID
   * @returns {boolean} True if product is a bundle
   */
  static async isBundleProduct(productId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('productId', sql.UniqueIdentifier, productId);

      const result = await request.query(`
        SELECT IsBundle
        FROM oe.Products
        WHERE ProductId = @productId
          AND Status = 'Active'
      `);

      return result.recordset.length > 0 && result.recordset[0].IsBundle === true;

    } catch (error) {
      console.error(`Error checking if product ${productId} is bundle:`, error);
      return false;
    }
  }

  /**
   * Get bundle product information
   * @param {string} bundleProductId - Bundle product ID
   * @returns {Object|null} Bundle product information
   */
  static async getBundleInfo(bundleProductId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('bundleProductId', sql.UniqueIdentifier, bundleProductId);

      const result = await request.query(`
        SELECT 
          ProductId,
          Name,
          Description,
          ProductType,
          IsBundle,
          Status
        FROM oe.Products
        WHERE ProductId = @bundleProductId
          AND IsBundle = 1
          AND Status = 'Active'
      `);

      if (result.recordset.length === 0) {
        return null;
      }

      const bundle = result.recordset[0];
      return {
        productId: bundle.ProductId,
        name: bundle.Name,
        description: bundle.Description,
        productType: bundle.ProductType,
        isBundle: bundle.IsBundle,
        status: bundle.Status
      };

    } catch (error) {
      console.error(`Error fetching bundle info for ${bundleProductId}:`, error);
      return null;
    }
  }

  /**
   * Calculate pricing for an included product in a bundle
   * @param {string} productId - Product ID
   * @param {Object} memberCriteria - Member criteria
   * @param {Object} configValues - Configuration values
   * @returns {Object} Product pricing result
   */
  static async calculateIncludedProductPricing(productId, memberCriteria, configValues = {}, effectiveDate = null, options = {}) {
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('productId', sql.UniqueIdentifier, productId);
      request.input('tierType', sql.NVarChar(10), memberCriteria.tier);
      request.input('memberAge', sql.Int, memberCriteria.age);
      // Convert tobacco status format (Y/N -> Yes/No)
      const tobaccoStatus = memberCriteria.tobaccoUse === 'Y' ? 'Yes' : 
                           memberCriteria.tobaccoUse === 'N' ? 'No' : 
                           memberCriteria.tobaccoUse;
      request.input('tobaccoStatus', sql.NVarChar(50), tobaccoStatus);
      
      // Add effective date parameter if provided
      if (effectiveDate) {
        request.input('effectiveDate', sql.Date, effectiveDate);
      }

      // Get product information
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

      // Get pricing information - filter by config value if provided
      // Treat 'Default' as empty (no config selected)
      let configValue1 = configValues.configValue1 || configValues.ConfigValue1;
      if (configValue1 === 'Default') {
        configValue1 = null;
      }
      
      // Check if product has configuration fields by querying for pricing records with config values
      // We'll determine this after getting pricing, not by hardcoding field names
      // For now, if configValue1 is provided, we'll try to use it and let the query determine if it matches
      
      // Add config parameter if config value provided (needed for both query paths)
      if (configValue1) {
        request.input('configValue1', sql.NVarChar, String(configValue1));
      }
      
      // Filter by EffectiveDate if provided: EffectiveDate <= effectiveDate AND (TerminationDate IS NULL OR TerminationDate >= effectiveDate)
      // If multiple records match, use ROW_NUMBER to pick the most recent EffectiveDate
      // When config is specified, ONLY match exact config value (no NULL fallback)
      // If config is provided, try to match it; if no match, the query will return no results and we'll handle that
      const configFilter = configValue1 ? ' AND pp.ConfigValue1 = @configValue1' : '';
      
      let pricingQuery = effectiveDate ? `
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
          pp.ConfigValue1,
          pp.ConfigValue2,
          pp.ConfigValue3,
          pp.ConfigValue4,
          pp.ConfigValue5,
          pp.Status
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
            AND (pp.TerminationDate IS NULL OR CAST(pp.TerminationDate AS DATE) >= @effectiveDate)${configFilter}
        ) pp
        WHERE pp.RowNum = 1` : `
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
          pp.ConfigValue1,
          pp.ConfigValue2,
          pp.ConfigValue3,
          pp.ConfigValue4,
          pp.ConfigValue5,
          pp.Status
        FROM oe.ProductPricing pp
        WHERE pp.ProductId = @productId
          AND pp.TierType = @tierType
          AND pp.Status = 'Active'
          AND pp.MinAge <= @memberAge
          AND (pp.MaxAge IS NULL OR pp.MaxAge >= @memberAge)
          AND (pp.TobaccoStatus = @tobaccoStatus OR pp.TobaccoStatus = 'N/A')${configFilter}`;
      
      // Order by MinAge DESC to get the most specific age match
      pricingQuery += ` ORDER BY pp.MinAge DESC`;
      
      let pricingResult = await request.query(pricingQuery);

      // If config was provided but no match found, try again without config filter
      // This handles non-configurable products that received a config value
      if (pricingResult.recordset.length === 0 && configValue1) {
        const fallbackPayload = {
          event: 'bundle_processor_pricing_config_fallback',
          productId: String(productId),
          memberTier: memberCriteria?.tier,
          memberAge: memberCriteria?.age,
          tobaccoUse: memberCriteria?.tobaccoUse,
          configValue1: String(configValue1),
          reason: 'no pricing row with config filter; retrying without ConfigValue1 filter'
        };
        console.warn(JSON.stringify(fallbackPayload));
        const fallbackQuery = pricingQuery.replace(configFilter, '');
        pricingResult = await request.query(fallbackQuery);
      }

      if (pricingResult.recordset.length === 0) {
        throw new Error(`No pricing found for product ${productId} with tier ${memberCriteria.tier}, age ${memberCriteria.age}, tobacco ${memberCriteria.tobaccoUse}`);
      }

      const pricing = pricingResult.recordset[0];

      // Use MSRPRate directly as the premium - it already includes everything calculated
      // MSRPRate = NetRate + OverrideRate + VendorCommission + SystemFees
      let finalPremium = Number(pricing.MSRPRate) || 0;
      
      // Ensure it's a number
      finalPremium = Number(finalPremium);

      // Check if this product has configuration fields
      const hasConfigFields = pricing.ConfigValue1 || pricing.ConfigValue2 || pricing.ConfigValue3 || 
                             pricing.ConfigValue4 || pricing.ConfigValue5;
      
      // Get all pricing records for this product to build configuration options
      // Filter by EffectiveDate if provided
      const allPricingQuery = effectiveDate ? `
        SELECT 
          pp.ProductPricingId,
          pp.ConfigValue1,
          pp.ConfigValue2,
          pp.ConfigValue3,
          pp.ConfigValue4,
          pp.ConfigValue5,
          pp.NetRate,
          pp.OverrideRate,
          pp.VendorCommission,
          pp.SystemFees,
          pp.MSRPRate,
          pp.IncludedProcessingFee
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
        ORDER BY pp.ConfigValue1, pp.ConfigValue2, pp.ConfigValue3, pp.ConfigValue4, pp.ConfigValue5
      ` : `
        SELECT 
          pp.ProductPricingId,
          pp.ConfigValue1,
          pp.ConfigValue2,
          pp.ConfigValue3,
          pp.ConfigValue4,
          pp.ConfigValue5,
          pp.NetRate,
          pp.OverrideRate,
          pp.VendorCommission,
          pp.SystemFees,
          pp.MSRPRate,
          pp.IncludedProcessingFee
        FROM oe.ProductPricing pp
        WHERE pp.ProductId = @productId
          AND pp.TierType = @tierType
          AND pp.Status = 'Active'
          AND pp.MinAge <= @memberAge
          AND (pp.MaxAge IS NULL OR pp.MaxAge >= @memberAge)
          AND (pp.TobaccoStatus = @tobaccoStatus OR pp.TobaccoStatus = 'N/A')
        ORDER BY pp.ConfigValue1, pp.ConfigValue2, pp.ConfigValue3, pp.ConfigValue4, pp.ConfigValue5
      `;
      
      const allPricingResult = await request.query(allPricingQuery);

      // Parse RequiredDataFields from product to get proper field names and options
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
        console.warn(`Failed to parse RequiredDataFields for included product ${productId}:`, error);
      }

      // Build configuration fields if product has config options
      let configFields = {
        hasConfigurationFields: false,
        availableConfigs: [],
        requiredDataFields: requiredDataFields, // Use parsed RequiredDataFields
        defaultConfig: null,
        pricingVariations: []
      };

      // Build pricing variations from ALL pricing records (for all config values like 1500, 3000, etc.)
      // This ensures frontend can switch between config values without refetching
      if (allPricingResult.recordset.length > 0) {
        // Get unique config values from pricing records
        const uniqueConfigValues = [...new Set(allPricingResult.recordset
          .map(record => record.ConfigValue1)
          .filter(value => value && value.trim() !== '')
        )].sort();
        
        if (uniqueConfigValues.length > 0) {
          configFields.hasConfigurationFields = true;
          
          // Use RequiredDataFields if available, otherwise use config values from pricing
          if (requiredDataFields.length > 0) {
            configFields.availableConfigs = availableConfigs;
          } else {
            configFields.availableConfigs = uniqueConfigValues;
          }
          
          // Set default to first available config (NOT "Default")
          configFields.defaultConfig = configFields.availableConfigs.length > 0 ? configFields.availableConfigs[0] : null;
          
          // Parse the RequiredDataFields from the product to get the correct field name
          let fieldName = 'Configuration'; // Default fallback
          try {
            if (product.RequiredDataFields) {
              const requiredFields = JSON.parse(product.RequiredDataFields);
              if (requiredFields && requiredFields.length > 0 && requiredFields[0].fieldName) {
                fieldName = requiredFields[0].fieldName;
              }
            }
          } catch (error) {
            console.log(`⚠️ Could not parse RequiredDataFields for product ${productId}, using default field name`);
          }
          
          if (requiredDataFields.length === 0) {
            configFields.requiredDataFields = [{
              id: Date.now().toString(),
              fieldName: fieldName,
              fieldOptions: uniqueConfigValues
            }];
          } else {
            configFields.requiredDataFields = requiredDataFields;
          }
          
          // Build pricing variations from ALL pricing records with actual config values (1500, 3000, etc.)
          // Filter out records with null/empty ConfigValue1 - only include actual config values
          configFields.pricingVariations = allPricingResult.recordset
            .filter(record => record.ConfigValue1 && String(record.ConfigValue1).trim() !== '') // Only include records with actual config values
            .map(record => {
              const configValue = String(record.ConfigValue1); // Use actual config value (1500, 3000, etc.) - NO "Default" fallback
              // Use MSRPRate directly as the premium - it already includes everything calculated
              // MSRPRate = NetRate + OverrideRate + VendorCommission + SystemFees
              const configPremium = Number(record.MSRPRate) || 0;

              return {
                configValue: configValue, // Use actual config value (1500, 3000, etc.)
                // CRITICAL: Ensure all pricing values are numbers
                monthlyPremium: Number(configPremium),
                basePremium: Number(configPremium),
                configAdjustment: 0,
                employerContribution: 0,
                employeeContribution: Number(configPremium),
                pricingDetails: {
                  productPricingId: record.ProductPricingId,
                  netRate: Number(record.NetRate) || 0,
                  overrideRate: Number(record.OverrideRate) || 0,
                  vendorCommission: Number(record.VendorCommission) || 0,
                  systemFees: Number(record.SystemFees) || 0,
                  isVendorPrice: product.IsVendorPrice
                }
              };
            });
          
          console.log(`✅ DEBUG: Built ${configFields.pricingVariations.length} pricing variations for included product ${productId} (${product.ProductName}):`, 
            configFields.pricingVariations.map(v => `${v.configValue}: $${v.monthlyPremium}`).join(', '));
        }
      }
      
      // Legacy fallback - remove this after testing
      if (!configFields.hasConfigurationFields && hasConfigFields && allPricingResult.recordset.length > 0) {
        // Fallback: Get unique config values from the first config field
        const configValues = [...new Set(allPricingResult.recordset
          .map(record => record.ConfigValue1)
          .filter(value => value && value.trim() !== '')
        )].sort();

        if (configValues.length > 0) {
          configFields.hasConfigurationFields = true;
          configFields.availableConfigs = configValues;
          configFields.defaultConfig = configValues[0];
          
          // Parse the RequiredDataFields from the product to get the correct field name
          let fieldName = 'Configuration'; // Default fallback
          try {
            if (product.RequiredDataFields) {
              const requiredFields = JSON.parse(product.RequiredDataFields);
              if (requiredFields && requiredFields.length > 0 && requiredFields[0].fieldName) {
                fieldName = requiredFields[0].fieldName;
              }
            }
          } catch (error) {
            console.log(`⚠️ Could not parse RequiredDataFields for product ${productId}, using default field name`);
          }
          
          configFields.requiredDataFields = [{
            id: Date.now().toString(),
            fieldName: fieldName,
            fieldOptions: configValues
          }];

          // Build pricing variations
          configFields.pricingVariations = allPricingResult.recordset.map(record => {
            const configValue = record.ConfigValue1 || 'Default';
            // Use MSRPRate directly as the premium - it already includes everything calculated
            // MSRPRate = NetRate + OverrideRate + VendorCommission + SystemFees
            const configPremium = Number(record.MSRPRate) || 0;

            return {
              configValue: configValue,
              // CRITICAL: Ensure all pricing values are numbers
              monthlyPremium: Number(configPremium),
              basePremium: Number(configPremium),
              configAdjustment: 0,
              employerContribution: 0,
              employeeContribution: Number(configPremium),
              pricingDetails: {
                productPricingId: record.ProductPricingId,
                netRate: Number(record.NetRate) || 0,
                overrideRate: Number(record.OverrideRate) || 0,
                vendorCommission: Number(record.VendorCommission) || 0,
                systemFees: Number(record.SystemFees) || 0,
                includedProcessingFee: Number(record.IncludedProcessingFee) || 0,
                isVendorPrice: product.IsVendorPrice
              }
            };
          });
        }
      }

      // Ensure all products have at least one pricing variation
      // Only create "Default" variation if there are truly no config fields
      if (!configFields.pricingVariations || configFields.pricingVariations.length === 0) {
        // If we have availableConfigs, use the first one as the default config value
        const defaultConfigValue = configFields.availableConfigs && configFields.availableConfigs.length > 0
          ? String(configFields.availableConfigs[0])
          : 'Default';
        
        configFields.pricingVariations = [{
          configValue: defaultConfigValue, // Use first available config or "Default" as last resort
          monthlyPremium: Number(finalPremium),
          basePremium: Number(finalPremium), // Use finalPremium directly
          configAdjustment: 0, // No adjustment needed
          employerContribution: 0,
          employeeContribution: Number(finalPremium),
          pricingDetails: {
            productPricingId: pricing.ProductPricingId,
            netRate: Number(pricing.NetRate) || 0,
            overrideRate: Number(pricing.OverrideRate) || 0,
            vendorCommission: Number(pricing.VendorCommission) || 0,
            systemFees: Number(pricing.SystemFees) || 0,
            includedProcessingFee: Number(pricing.IncludedProcessingFee) || 0,
            isVendorPrice: product.IsVendorPrice
          }
        }];
      }

      const PricingEngine = require('./PricingEngine');
      const rawResult = {
        productId: product.ProductId,
        productName: product.ProductName,
        productType: product.ProductType,
        isBundle: product.IsBundle,
        tierType: pricing.TierType,
        tobaccoStatus: pricing.TobaccoStatus,
        memberAge: memberCriteria.age,
        // CRITICAL: Ensure monthlyPremium is returned as a number
        monthlyPremium: Number(finalPremium),
        basePremium: Number(finalPremium),
        configAdjustment: 0, // No adjustment - premium already matches config
        pricingDetails: {
          productPricingId: pricing.ProductPricingId,
          netRate: Number(pricing.NetRate) || 0,
          overrideRate: Number(pricing.OverrideRate) || 0,
          vendorCommission: Number(pricing.VendorCommission) || 0,
          systemFees: Number(pricing.SystemFees) || 0,
          includedProcessingFee: Number(pricing.IncludedProcessingFee) || 0,
          isVendorPrice: product.IsVendorPrice
        },
        configValues: configValues,
        calculatedAt: new Date().toISOString(),
        // Add configuration fields for frontend compatibility
        ...configFields
      };

      return await PricingEngine.applyProcessingFeeEnrichment(
        rawResult,
        productId,
        options || {}
      );

    } catch (error) {
      console.error(`Error calculating included product pricing for ${productId}:`, error);
      throw new Error(`Included product pricing calculation failed: ${error.message}`);
    }
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

    // CRITICAL: Ensure return value is a number, not a string
    return Number(adjustment || 0);
  }

  /**
   * Validate bundle configuration
   * @param {string} bundleProductId - Bundle product ID
   * @param {Object} configValues - Configuration values
   * @returns {Object} Validation result
   */
  static async validateBundleConfiguration(bundleProductId, configValues) {
    try {
      const includedProducts = await this.getBundleIncludedProducts(bundleProductId);
      const validation = {
        isValid: true,
        errors: [],
        warnings: []
      };

      // Check if all required included products have configuration
      for (const includedProduct of includedProducts) {
        if (!configValues[includedProduct.productId]) {
          validation.warnings.push(`No configuration provided for included product: ${includedProduct.productName}`);
        }
      }

      // Check for extra configuration for non-included products
      const includedProductIds = includedProducts.map(p => p.productId);
      for (const configProductId of Object.keys(configValues)) {
        if (!includedProductIds.includes(configProductId)) {
          validation.warnings.push(`Configuration provided for non-included product: ${configProductId}`);
        }
      }

      return validation;

    } catch (error) {
      return {
        isValid: false,
        errors: [`Bundle validation failed: ${error.message}`],
        warnings: []
      };
    }
  }
}

module.exports = BundleProcessor;
