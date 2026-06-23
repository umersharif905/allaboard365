/**
 * CONTRIBUTION CALCULATOR - Employer contribution logic with critical bug fix
 * 
 * CRITICAL FIX: "All products" rules now apply to TOTAL cost, not per-product
 * 
 * Used by: PricingEngine for calculating employer contributions
 */

const { getPool, sql } = require('../../config/database');
const PricingValidator = require('./PricingValidator');

class ContributionCalculator {
  /**
   * Calculate employer contributions with correct logic
   * @param {Object} params - Contribution parameters
   * @param {string} params.groupId - Group ID
   * @param {Array} params.productPricingResults - Product pricing results
   * @param {Object} params.memberCriteria - Member criteria for rules
   * @param {number} params.additionalFees - Optional: Additional fees (system + processing); included in the calculation base for all all-products rules (percentage, flat, tier, etc.)
   * @param {Object} [params.equivalentTierBases] - Optional: For percentage + EquivalentTier, base including fees. Keys: tier (EE/ES/EC/EF), values: { productTotal, totalWithFees }. When set, 50% of EE = 50% of (EE product total + system + processing fee on that total).
   * @returns {Object} Contribution breakdown
   */
  static async calculateContributions(params) {
    try {
      const { groupId, productPricingResults, memberCriteria, additionalFees = 0, equivalentTierBases = null } = params;

      console.log('🔍 DEBUG: calculateContributions called with:', {
        groupId,
        productCount: productPricingResults?.length || 0,
        memberCriteria: {
          age: memberCriteria?.age,
          tier: memberCriteria?.tier,
          jobPosition: memberCriteria?.jobPosition || memberCriteria?.JobPosition || 'NOT PROVIDED',
          tobaccoUse: memberCriteria?.tobaccoUse
        }
      });

      // Validate inputs
      if (!groupId) {
        throw new Error('groupId is required for contribution calculation');
      }

      if (!Array.isArray(productPricingResults) || productPricingResults.length === 0) {
        return {
          employerTotal: 0,
          employeeTotal: 0,
          productContributions: {},
          allProductsContribution: 0,
          appliedRules: [],
          calculationDetails: 'No products to calculate contributions for'
        };
      }

      // 1. Get all active contribution rules for the group
      const contributionRules = await this.getGroupContributionRules(groupId);

      console.log(`🔍 DEBUG: Retrieved ${contributionRules?.length || 0} contribution rules for group ${groupId}`);
      
      if (contributionRules && contributionRules.length > 0) {
        console.log('🔍 DEBUG: Contribution rules details:', contributionRules.map(rule => ({
          name: rule.Name,
          type: rule.ContributionType,
          productId: rule.ProductId,
          jobPositions: rule.JobPositions ? (typeof rule.JobPositions === 'string' ? JSON.parse(rule.JobPositions) : rule.JobPositions) : null,
          ageRules: rule.AgeRules ? (typeof rule.AgeRules === 'string' ? JSON.parse(rule.AgeRules) : rule.AgeRules) : null
        })));
      }

      if (!contributionRules || contributionRules.length === 0) {
        // No contribution rules - member pays full premium
        const totalPremium = productPricingResults.reduce((sum, p) => sum + p.monthlyPremium, 0);
        return {
          employerTotal: 0,
          employeeTotal: totalPremium,
          productContributions: this.createEmptyProductContributions(productPricingResults),
          allProductsContribution: 0,
          appliedRules: [],
          calculationDetails: 'No contribution rules found for group'
        };
      }

      // 2. Separate product-specific from all-products rules (support multi-product via _productIds)
      const productSpecificRules = contributionRules.filter(rule =>
        rule.ProductId !== null || (rule._productIds && rule._productIds.length > 0)
      );
      const allProductsRules = contributionRules.filter(rule =>
        rule.ProductId === null && (!rule._productIds || rule._productIds.length === 0)
      );

      console.log(`🔍 DEBUG: Found ${productSpecificRules.length} product-specific rules and ${allProductsRules.length} all-products rules`);

      // 3. Apply product-specific rules first
      const totalPremium = productPricingResults.reduce((sum, p) => sum + p.monthlyPremium, 0);
      const { productContributions, totalProductSpecificContribution } =
        await ContributionCalculator._applyProductSpecificRules(
          productSpecificRules,
          productPricingResults,
          memberCriteria,
          equivalentTierBases,
          totalPremium,
          additionalFees || 0
        );

      // 4. Apply all-products rules to remaining total (CRITICAL FIX)
      // All contribution rules use total including system + processing fees as the calculation base
      const totalWithFees = totalPremium + (additionalFees || 0);
      const remainingPremium = totalPremium - totalProductSpecificContribution;
      const remainingIncludingFees = remainingPremium + (additionalFees || 0);

      console.log(`🔍 DEBUG: Total premium: $${totalPremium}, Fees: $${additionalFees || 0}, Total with fees: $${totalWithFees}, Remaining (with fees): $${remainingIncludingFees}`);

      // Filter all-products rules by member criteria
      const applicableAllProductsRules = allProductsRules.filter(rule => {
        const appliesToMember = this.ruleAppliesToMember(rule, memberCriteria);
        
        console.log(`🔍 DEBUG: Checking all-products rule "${rule.Name}":`, {
          appliesToMember,
          ruleJobPositions: rule.JobPositions ? (typeof rule.JobPositions === 'string' ? JSON.parse(rule.JobPositions) : rule.JobPositions) : null,
          memberJobPosition: memberCriteria?.jobPosition || memberCriteria?.JobPosition || 'NOT PROVIDED',
          ruleType: rule.ContributionType
        });
        
        return appliesToMember;
      });
      
      console.log(`🔍 DEBUG: Found ${applicableAllProductsRules.length} applicable all-products rules (out of ${allProductsRules.length} total)`);

      const allProductsResult = await this.applyAllProductsRules(
        remainingIncludingFees,
        applicableAllProductsRules,
        memberCriteria,
        productPricingResults,
        equivalentTierBases
      );
      
      // applyAllProductsRules returns an object with employerContribution and maxEmployeeAmount (if MaxEmployee rules apply)
      const allProductsContribution = typeof allProductsResult === 'object' ? allProductsResult.employerContribution : allProductsResult;
      const maxEmployeeAmount = typeof allProductsResult === 'object' ? allProductsResult.maxEmployeeAmount : null;

      console.log(`🔍 DEBUG: All-products contribution: $${allProductsContribution}${maxEmployeeAmount !== null ? `, MaxEmployee: $${maxEmployeeAmount}` : ''}`);

      // 5. Distribute all-products contribution proportionally
      const distributedContributions = this.distributeAllProductsContribution(
        allProductsContribution,
        productPricingResults,
        productContributions
      );

      // 6. Calculate final totals
      const totalEmployerContribution = totalProductSpecificContribution + allProductsContribution;
      
      // For MaxEmployee rules: employee pays min(maxEmployeeAmount, totalWithFees)
      // For other rules: employee pays (totalWithFees - employerContribution) so employer + employee = total with fees
      let finalEmployeeContribution;
      if (maxEmployeeAmount !== null) {
        finalEmployeeContribution = Math.min(maxEmployeeAmount, totalWithFees);
        console.log(`🔍 DEBUG: MaxEmployee employee contribution: min(${maxEmployeeAmount}, ${totalWithFees}) = ${finalEmployeeContribution}`);
      } else {
        const totalEmployeeContribution = totalWithFees - totalEmployerContribution;
        finalEmployeeContribution = Math.max(0, totalEmployeeContribution);
      }

      // Ensure employer contribution doesn't exceed total (premium + fees)
      const finalEmployerContribution = Math.min(totalEmployerContribution, totalWithFees);
      
      // Verify: employer + employee should equal totalPremium + fees (when MaxEmployee rules apply)
      if (maxEmployeeAmount !== null) {
        const calculatedTotal = finalEmployerContribution + finalEmployeeContribution;
        if (Math.abs(calculatedTotal - totalWithFees) > 0.01) {
          console.warn(`⚠️ Contribution mismatch: employer (${finalEmployerContribution}) + employee (${finalEmployeeContribution}) = ${calculatedTotal}, expected ${totalWithFees}`);
        }
      }

      return {
        employerTotal: finalEmployerContribution,
        employeeTotal: finalEmployeeContribution,
        productContributions: distributedContributions,
        allProductsContribution: allProductsContribution,
        appliedRules: [...productSpecificRules, ...allProductsRules],
        calculationDetails: {
          totalPremium,
          productSpecificContribution: totalProductSpecificContribution,
          allProductsContribution,
          finalEmployerContribution,
          finalEmployeeContribution
        }
      };

    } catch (error) {
      console.error('❌ Error calculating contributions:', error);
      throw new Error(`Contribution calculation failed: ${error.message}`);
    }
  }

  /**
   * CRITICAL FIX: Distribute all-products contribution proportionally
   * @param {number} allProductsContribution - Total all-products contribution
   * @param {Array} productPricingResults - Product pricing results
   * @param {Object} productContributions - Existing product-specific contributions
   * @returns {Object} Distributed contributions per product
   */
  static distributeAllProductsContribution(allProductsContribution, productPricingResults, productContributions) {
    const totalPremium = productPricingResults.reduce((sum, p) => sum + p.monthlyPremium, 0);
    const distributedContributions = {};

    if (totalPremium <= 0) {
      // No premium to distribute
      for (const product of productPricingResults) {
        distributedContributions[product.productId] = {
          productSpecific: productContributions[product.productId] || 0,
          allProductsShare: 0,
          total: productContributions[product.productId] || 0,
          employeeContribution: product.monthlyPremium
        };
      }
      return distributedContributions;
    }

    for (const product of productPricingResults) {
      const proportion = product.monthlyPremium / totalPremium;
      const distributedAmount = allProductsContribution * proportion;
      const productSpecificAmount = productContributions[product.productId] || 0;
      const totalContribution = productSpecificAmount + distributedAmount;
      const employeeContribution = Math.max(0, product.monthlyPremium - totalContribution);

      distributedContributions[product.productId] = {
        productSpecific: productSpecificAmount,
        allProductsShare: distributedAmount,
        total: totalContribution,
        employeeContribution: employeeContribution,
        proportion: proportion
      };
    }

    return distributedContributions;
  }

  /**
   * Apply product-specific contribution rules to all products in productPricingResults.
   * Pure static method — no DB access. Extracted for testability.
   * @param {Array} productSpecificRules - Rules with a ProductId (or _productIds)
   * @param {Array} productPricingResults - Products being priced
   * @param {Object} memberCriteria - Member criteria for rule matching
   * @param {Object} equivalentTierBases - { tier: { productTotal, totalWithFees } }
   * @param {number} totalPremium - Sum of all product premiums
   * @param {number} additionalFees - System + processing fees
   * @returns {{ productContributions: Object, totalProductSpecificContribution: number }}
   */
  static async _applyProductSpecificRules(
    productSpecificRules,
    productPricingResults,
    memberCriteria,
    equivalentTierBases,
    totalPremium,
    additionalFees
  ) {
    const productContributions = {};
    let totalProductSpecificContribution = 0;

    // Get list of selected product IDs from productPricingResults (these are the products being processed)
    const selectedProductIds = productPricingResults.map(p => p.productId);
    console.log(`🔍 DEBUG: Processing contributions for selected products:`, selectedProductIds);

    for (const product of productPricingResults) {
      // Filter product-specific rules to ONLY apply to this product (double-check it's in selected products)
      // A line matches if its own ProductId is targeted, or if it carries a parentBundleId
      // pointing at a targeted bundle. The rule does NOT fan out to every line that shares
      // an id with a bundle component — that would zero out a standalone purchase of a
      // product that also happens to be bundled elsewhere.
      const applicableRules = productSpecificRules.filter(rule => {
        const pidNorm = ContributionCalculator._normalizeId(product.productId);
        const parentNorm = product.parentBundleId
          ? ContributionCalculator._normalizeId(product.parentBundleId)
          : '';
        const ruleTargets = (rule._productIds && rule._productIds.length > 0)
          ? rule._productIds
          : (rule.ProductId ? [ContributionCalculator._normalizeId(rule.ProductId)] : []);
        const matchesProduct = ruleTargets.includes(pidNorm)
          || (parentNorm && ruleTargets.includes(parentNorm));
        if (!matchesProduct) {
          console.log(`⏭️ Skipping rule "${rule.Name}" - does not match product ${product.productId}`);
          return false;
        }

        // Verify this product is in the selected products list
        if (!selectedProductIds.includes(product.productId)) {
          console.log(`⏭️ Skipping product-specific rule "${rule.Name}" for product ${product.productId} - product not selected`);
          return false;
        }

        const appliesToMember = ContributionCalculator.ruleAppliesToMember(rule, memberCriteria);

        console.log(`🔍 DEBUG: Checking rule "${rule.Name}" for product ${product.productId}:`, {
          matchesProduct,
          productIsSelected: selectedProductIds.includes(product.productId),
          appliesToMember,
          ruleJobPositions: rule.JobPositions ? (typeof rule.JobPositions === 'string' ? JSON.parse(rule.JobPositions) : rule.JobPositions) : null,
          memberJobPosition: memberCriteria?.jobPosition || memberCriteria?.JobPosition || 'NOT PROVIDED',
          ruleType: rule.ContributionType
        });

        return appliesToMember;
      });

      console.log(`🔍 DEBUG: Found ${applicableRules.length} applicable product-specific rules for product ${product.productId}`);

      const productContribution = await ContributionCalculator.applyRulesToProduct(
        product,
        applicableRules,
        memberCriteria,
        equivalentTierBases,
        totalPremium,
        additionalFees
      );

      productContributions[product.productId] = productContribution;
      totalProductSpecificContribution += productContribution;
    }

    return { productContributions, totalProductSpecificContribution };
  }

  /**
   * Apply contribution rules to a specific product
   * @param {Object} product - Product pricing result
   * @param {Array} rules - Applicable rules for this product
   * @param {Object} memberCriteria - Member criteria
   * @param {Object} [equivalentTierBases] - Optional: { tier: { productTotal, totalWithFees } } for percentage + EquivalentTier including fees
   * @param {number} [totalPremium] - Total of all product premiums (for percentage base including fees)
   * @param {number} [additionalFees] - System + processing fees (included in percentage base so product-specific matches all-products)
   * @returns {number} Total contribution for this product
   */
  static async applyRulesToProduct(product, rules, memberCriteria, equivalentTierBases = null, totalPremium = 0, additionalFees = 0) {
    if (!rules || rules.length === 0) {
      return 0;
    }

    let totalContribution = 0;
    let stopProcessing = false;

    // Sort rules by priority
    const sortedRules = rules.sort((a, b) => (a.Priority || 0) - (b.Priority || 0));

    for (const rule of sortedRules) {
      if (stopProcessing) {
        break;
      }

      try {
        const ruleContribution = await this.applyRuleToProduct(product, rule, memberCriteria, equivalentTierBases, totalPremium, additionalFees);
        
        if (ruleContribution > 0) {
          totalContribution += ruleContribution;
          
          // Check if rules should stack or stop processing
          if (rule.Stacking === false) {
            stopProcessing = true;
          }
        }
      } catch (error) {
        console.warn(`Error applying rule ${rule.Name} to product ${product.productId}:`, error);
        // Continue with other rules
      }
    }

    // Ensure contribution doesn't exceed product premium
    return Math.min(totalContribution, product.monthlyPremium);
  }

  /**
   * Apply a single rule to a product
   * @param {Object} product - Product pricing result
   * @param {Object} rule - Contribution rule
   * @param {Object} memberCriteria - Member criteria
   * @param {Object} [equivalentTierBases] - Optional: { tier: { productTotal, totalWithFees } } for percentage + EquivalentTier including fees
   * @param {number} [totalPremium] - Total of all product premiums
   * @param {number} [additionalFees] - Fees to include in percentage base (so product-specific total matches all-products)
   * @returns {number} Contribution amount from this rule
   */
  static async applyRuleToProduct(product, rule, memberCriteria, equivalentTierBases = null, totalPremium = 0, additionalFees = 0) {
    // Validate rule applies to this member
    if (!this.ruleAppliesToMember(rule, memberCriteria)) {
      return 0;
    }

    const direction = rule.ContributionDirection || 'Employer'; // Default to 'Employer' for backward compatibility
    let contributionAmount = 0;

    switch (rule.ContributionType) {
      case 'flat_rate':
        contributionAmount = Number(rule.FlatRateAmount) || 0;
        break;

      case 'percentage': {
        const percentage = Number(rule.PercentageAmount) || 0;
        const eqTier = rule.EquivalentTier != null && String(rule.EquivalentTier).trim() !== ''
          ? String(rule.EquivalentTier).trim().toUpperCase()
          : null;
        // Percentage rules may include fees:
        // - For normal % rules: use product premium + proportional share of additionalFees.
        // - For EquivalentTier % rules: use equivalent tier base + proportional share of that tier's fees (from equivalentTierBases).
        const basePremiumOnly = eqTier
          ? ((product.equivalentPremiums && product.equivalentPremiums[eqTier]) ?? product.monthlyPremium)
          : product.monthlyPremium;

        let feeShare = 0;
        if (eqTier && equivalentTierBases && equivalentTierBases[eqTier]) {
          const tierBase = equivalentTierBases[eqTier];
          const tierProductTotal = Number(tierBase.productTotal || 0);
          const tierTotalWithFees = Number(tierBase.totalWithFees || 0);
          const tierFees = Math.max(0, tierTotalWithFees - tierProductTotal);
          feeShare = tierProductTotal > 0 ? (Number(basePremiumOnly || 0) / tierProductTotal) * tierFees : 0;
        } else if (!eqTier && Number(additionalFees || 0) > 0 && Number(totalPremium || 0) > 0) {
          // Pro-rate additional fees by this product's share of total premium
          feeShare = (Number(product.monthlyPremium || 0) / Number(totalPremium || 0)) * Number(additionalFees || 0);
        }

        const baseWithFees = Number(basePremiumOnly || 0) + Number(feeShare || 0);
        contributionAmount = baseWithFees * (percentage / 100);

        // Cap at this product's base + its fee share (prevents runaway amounts)
        // IMPORTANT: for EquivalentTier rules, cap at the ACTUAL product total (not the equivalent base),
        // otherwise an "EE equivalent" feeShare could push the cap above the real premium+fees for this product.
        const cap = eqTier
          ? Number(product.monthlyPremium || 0)
          : (Number(product.monthlyPremium || 0) + Number(feeShare || 0));
        contributionAmount = Math.min(contributionAmount, cap);
        break;
      }

      case 'tier_based':
        contributionAmount = this.getTierContribution(rule, memberCriteria.tier);
        break;

      case 'age_based':
        contributionAmount = this.getAgeContribution(rule, memberCriteria.age, product.monthlyPremium);
        break;

      case 'role_based':
        contributionAmount = this.getRoleContribution(rule, memberCriteria);
        break;

      case 'override':
        if (rule.OverrideType === 'full_premium') {
          contributionAmount = product.monthlyPremium;
        } else {
          contributionAmount = Number(rule.OverrideAmount) || 0;
        }
        break;

      default:
        console.warn(`Unknown contribution type: ${rule.ContributionType}`);
        return 0;
    }

    // Handle MaxEmployee direction: contributionAmount is the MAX employee pays
    // Return the employer contribution (premium - maxEmployee)
    if (direction === 'MaxEmployee') {
      const maxEmployeeAmount = contributionAmount;
      const employerContribution = Math.max(0, product.monthlyPremium - maxEmployeeAmount);
      console.log(`🔍 DEBUG: MaxEmployee rule "${rule.Name}" for product ${product.productId}: maxEmployee=${maxEmployeeAmount}, premium=${product.monthlyPremium}, employerContribution=${employerContribution}`);
      return employerContribution;
    }

    // For 'Employer' direction, return the contribution amount as employer contribution
    return contributionAmount;
  }

  /**
   * Apply all-products rules to remaining total (premium + fees).
   * @param {number} remainingIncludingFees - Remaining amount after product-specific rules, including system + processing fees (base for all rule calculations)
   * @param {Array} allProductsRules - All-products rules
   * @param {Object} memberCriteria - Member criteria
   * @param {Array} [productPricingResults] - Full product list (for percentage + EquivalentTier rules)
   * @returns {number|Object} Total all-products contribution, or { employerContribution, maxEmployeeAmount } for MaxEmployee
   */
  static async applyAllProductsRules(remainingIncludingFees, allProductsRules, memberCriteria, productPricingResults = [], equivalentTierBases = null) {
    if (remainingIncludingFees <= 0 || !allProductsRules || allProductsRules.length === 0) {
      return 0;
    }

    // Separate MaxEmployee rules from other rules
    const maxEmployeeRules = [];
    const otherRules = [];
    
    for (const rule of allProductsRules) {
      if (this.ruleAppliesToMember(rule, memberCriteria)) {
        const direction = rule.ContributionDirection || 'Employer';
        if (direction === 'MaxEmployee') {
          maxEmployeeRules.push(rule);
        } else {
          otherRules.push(rule);
        }
      }
    }

    // For MaxEmployee rules: take the MINIMUM maxEmployee amount (all use premium + fees as base)
    let maxEmployeeAmount = null;
    if (maxEmployeeRules.length > 0) {
      const maxEmployeeAmounts = [];
      for (const rule of maxEmployeeRules) {
        let contributionAmount = 0;
        switch (rule.ContributionType) {
          case 'flat_rate':
            contributionAmount = Number(rule.FlatRateAmount) || 0;
            break;
          case 'percentage': {
            const percentage = Number(rule.PercentageAmount) || 0;
            const eqTier = rule.EquivalentTier != null && String(rule.EquivalentTier).trim() !== ''
              ? String(rule.EquivalentTier).trim().toUpperCase()
              : null;
            if (eqTier && Array.isArray(productPricingResults) && productPricingResults.length > 0) {
              const tierBase = equivalentTierBases && equivalentTierBases[eqTier]
                ? equivalentTierBases[eqTier]
                : null;
              const totalBase = tierBase
                ? Number(tierBase.totalWithFees || tierBase.productTotal || 0)
                : productPricingResults.reduce((sum, p) => sum + ((p.equivalentPremiums && p.equivalentPremiums[eqTier]) ?? p.monthlyPremium), 0);
              contributionAmount = Math.min(Number(totalBase || 0) * (percentage / 100), remainingIncludingFees);
            } else {
              contributionAmount = remainingIncludingFees * (percentage / 100);
            }
            break;
          }
          case 'tier_based':
            contributionAmount = this.getTierContribution(rule, memberCriteria.tier);
            console.log(`🔍 DEBUG: getTierContribution called with tier=${memberCriteria.tier}, rule=${rule.Name}, result=${contributionAmount}`);
            break;
          case 'age_based':
            contributionAmount = this.getAgeContribution(rule, memberCriteria.age, remainingIncludingFees);
            break;
          case 'role_based':
            contributionAmount = this.getRoleContribution(rule, memberCriteria);
            break;
          case 'override':
            if (rule.OverrideType === 'full_premium') {
              contributionAmount = remainingIncludingFees;
            } else {
              contributionAmount = Number(rule.OverrideAmount) || 0;
            }
            break;
        }
        
        if (contributionAmount > 0) {
          maxEmployeeAmounts.push(contributionAmount);
          console.log(`🔍 DEBUG: MaxEmployee rule "${rule.Name}": maxEmployee=${contributionAmount} (MATCHES)`);
        } else {
          console.log(`🔍 DEBUG: MaxEmployee rule "${rule.Name}": maxEmployee=${contributionAmount} (DOES NOT MATCH - age range or other criteria)`);
        }
      }
      
      if (maxEmployeeAmounts.length > 0) {
        maxEmployeeAmount = Math.min(...maxEmployeeAmounts);
        console.log(`🔍 DEBUG: Min MaxEmployee amount: ${maxEmployeeAmount} (from ${maxEmployeeAmounts.length} matching rules out of ${maxEmployeeRules.length} total)`);
      } else {
        maxEmployeeAmount = null;
        console.log(`🔍 DEBUG: No MaxEmployee rules matched member criteria - no MaxEmployee limit applies`);
      }
    }

    // Calculate employer contribution from MaxEmployee rules (remainingIncludingFees already has fees)
    let maxEmployeeEmployerContribution = 0;
    if (maxEmployeeAmount !== null) {
      if (remainingIncludingFees > maxEmployeeAmount) {
        maxEmployeeEmployerContribution = remainingIncludingFees - maxEmployeeAmount;
      } else {
        maxEmployeeEmployerContribution = 0;
      }
      console.log(`🔍 DEBUG: MaxEmployee calculation: remainingIncludingFees=${remainingIncludingFees}, maxEmployee=${maxEmployeeAmount}, employerContribution=${maxEmployeeEmployerContribution}`);
    }

    // Apply other (non-MaxEmployee) rules - all use remainingIncludingFees as base
    let otherRulesContribution = 0;
    let stopProcessing = false;

    // Sort rules by priority
    const sortedOtherRules = otherRules.sort((a, b) => (a.Priority || 0) - (b.Priority || 0));

    for (const rule of sortedOtherRules) {
      if (stopProcessing) {
        break;
      }

      try {
        const ruleContribution = await this.applyAllProductsRule(remainingIncludingFees, rule, memberCriteria, productPricingResults, equivalentTierBases);
        
        if (ruleContribution > 0) {
          otherRulesContribution += ruleContribution;
          
          // Check if rules should stack or stop processing
          if (rule.Stacking === false) {
            stopProcessing = true;
          }
        }
      } catch (error) {
        console.warn(`Error applying all-products rule ${rule.Name}:`, error);
        // Continue with other rules
      }
    }

    // If we have MaxEmployee rules, return both employer contribution and maxEmployeeAmount
    // so the caller can correctly calculate employee contribution
    // Otherwise return just the contribution amount
    if (maxEmployeeAmount !== null) {
      return {
        employerContribution: maxEmployeeEmployerContribution,
        maxEmployeeAmount: maxEmployeeAmount
      };
    }

    // Allow over-contributions (employee contribution will be capped at 0)
    return otherRulesContribution;
  }

  /**
   * Apply a single all-products rule
   * @param {number} remainingPremium - Remaining premium
   * @param {Object} rule - All-products rule
   * @param {Object} memberCriteria - Member criteria
   * @param {Array} [productPricingResults] - Full product list (for percentage + EquivalentTier)
   * @param {Object} [equivalentTierBases] - Optional: { tier: { productTotal, totalWithFees } } for percentage + EquivalentTier including fees
   * @returns {number} Contribution amount from this rule
   */
  static async applyAllProductsRule(remainingPremium, rule, memberCriteria, productPricingResults = [], equivalentTierBases = null) {
    // Validate rule applies to this member
    if (!this.ruleAppliesToMember(rule, memberCriteria)) {
      return 0;
    }

    const direction = rule.ContributionDirection || 'Employer';
    let contributionAmount = 0;

    switch (rule.ContributionType) {
      case 'flat_rate':
        contributionAmount = Number(rule.FlatRateAmount) || 0;
        break;

      case 'percentage': {
        const percentage = Number(rule.PercentageAmount) || 0;
        const eqTier = rule.EquivalentTier != null && String(rule.EquivalentTier).trim() !== ''
          ? String(rule.EquivalentTier).trim().toUpperCase()
          : null;
        if (eqTier && Array.isArray(productPricingResults) && productPricingResults.length > 0) {
          // Use equivalentTierBases (includes fees) when available; fallback to premium-only sum.
          const tierBase = equivalentTierBases && equivalentTierBases[eqTier]
            ? equivalentTierBases[eqTier]
            : null;
          const totalBase = tierBase
            ? Number(tierBase.totalWithFees || tierBase.productTotal || 0)
            : productPricingResults.reduce((sum, p) => sum + ((p.equivalentPremiums && p.equivalentPremiums[eqTier]) ?? p.monthlyPremium), 0);
          contributionAmount = Number(totalBase || 0) * (percentage / 100);
          contributionAmount = Math.min(contributionAmount, remainingPremium);
        } else {
          contributionAmount = remainingPremium * (percentage / 100);
        }
        break;
      }

      case 'tier_based':
        contributionAmount = this.getTierContribution(rule, memberCriteria.tier);
        break;

      case 'age_based':
        contributionAmount = this.getAgeContribution(rule, memberCriteria.age, remainingPremium);
        break;

      case 'role_based':
        contributionAmount = this.getRoleContribution(rule, memberCriteria);
        break;

      case 'override':
        if (rule.OverrideType === 'full_premium') {
          contributionAmount = remainingPremium;
        } else {
          contributionAmount = Number(rule.OverrideAmount) || 0;
        }
        break;

      default:
        console.warn(`Unknown all-products contribution type: ${rule.ContributionType}`);
        return 0;
    }

    // Handle MaxEmployee direction: contributionAmount is the MAX employee pays
    // Return the employer contribution (remainingPremium - maxEmployee)
    if (direction === 'MaxEmployee') {
      const maxEmployeeAmount = contributionAmount;
      const employerContribution = Math.max(0, remainingPremium - maxEmployeeAmount);
      console.log(`🔍 DEBUG: MaxEmployee rule "${rule.Name}": maxEmployee=${maxEmployeeAmount}, remainingPremium=${remainingPremium}, employerContribution=${employerContribution}`);
      return employerContribution;
    }

    // For 'Employer' direction, return the contribution amount as employer contribution
    return contributionAmount;
  }

  /** Normalize GUID for consistent string comparison (DB may return different casing/format). */
  static _normalizeId(id) {
    if (id == null) return '';
    const s = typeof id === 'string' ? id : String(id);
    return s.toLowerCase().trim();
  }

  /**
   * Populate rule._productIds from explicit GroupContributions targets only (normalized, lowercased).
   * Does not expand bundle membership into component SKUs — bundle-targeted rules match component
   * lines via product.parentBundleId in the product-specific matcher.
   *
   * Kept async with a `_pool` parameter for caller compatibility; pool is unused.
   * @param {Array} rules - Contribution rules (mutated in place)
   * @param {Object} _pool - Unused; preserved for caller signature
   */
  static async enrichRulesWithBundleProductIds(rules, _pool) {
    if (!rules || rules.length === 0) return;
    for (const rule of rules) {
      const ids = (rule._productIdsArray && rule._productIdsArray.length > 0)
        ? rule._productIdsArray
        : (rule.ProductId ? [rule.ProductId] : []);
      rule._productIds = ids.map(id => ContributionCalculator._normalizeId(id));
    }
  }

  /**
   * Get group contribution rules
   * @param {string} groupId - Group ID
   * @returns {Array} Array of contribution rules
   */
  static async getGroupContributionRules(groupId) {
    try {
      const pool = await getPool();
      
      // Check if new columns exist (for backward compatibility)
      let ageRulesColumnExists = false;
      let jobPositionsColumnExists = false;
      try {
        const ageRulesCheck = await pool.request().query(`
          SELECT 1
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = 'oe'
            AND TABLE_NAME = 'GroupContributions'
            AND COLUMN_NAME = 'AgeRules'
        `);
        ageRulesColumnExists = ageRulesCheck.recordset.length > 0;
      } catch (checkError) {
        console.warn('⚠️ Failed to verify AgeRules column existence:', checkError.message);
        ageRulesColumnExists = false;
      }
      
      try {
        const jobPositionsCheck = await pool.request().query(`
          SELECT 1
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = 'oe'
            AND TABLE_NAME = 'GroupContributions'
            AND COLUMN_NAME = 'JobPositions'
        `);
        jobPositionsColumnExists = jobPositionsCheck.recordset.length > 0;
      } catch (checkError) {
        console.warn('⚠️ Failed to verify JobPositions column existence:', checkError.message);
        jobPositionsColumnExists = false;
      }
      
      let equivalentTierColumnExists = false;
      try {
        const equivalentTierCheck = await pool.request().query(`
          SELECT 1
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = 'oe'
            AND TABLE_NAME = 'GroupContributions'
            AND COLUMN_NAME = 'EquivalentTier'
        `);
        equivalentTierColumnExists = equivalentTierCheck.recordset.length > 0;
      } catch (checkError) {
        console.warn('Failed to verify EquivalentTier column existence:', checkError.message);
        equivalentTierColumnExists = false;
      }
      let productIdsColumnExists = false;
      try {
        const pc = await pool.request().query(`
          SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'GroupContributions' AND COLUMN_NAME = 'ProductIds'
        `);
        productIdsColumnExists = pc.recordset.length > 0;
      } catch (_) {
        productIdsColumnExists = false;
      }
      
      // Build SELECT columns dynamically based on what exists
      const selectColumns = [
        'ContributionId',
        'GroupId',
        'ProductId',
        ...(productIdsColumnExists ? ['ProductIds'] : []),
        'Name',
        'ContributionType',
        'ContributionDirection',
        'FlatRateAmount',
        'PercentageAmount',
        ...(equivalentTierColumnExists ? ['EquivalentTier'] : []),
        'TierContributions',
        'RoleContributions',
        'TenureRules',
        ...(ageRulesColumnExists ? ['AgeRules'] : []),
        ...(jobPositionsColumnExists ? ['JobPositions'] : []),
        'OverrideType',
        'OverrideAmount',
        'MinimumAmount',
        'Stacking',
        'AppliesTo',
        'Priority',
        'Status',
        'EffectiveDate',
        'EndDate'
      ].join(', ');
      
      const request = pool.request();
      request.input('groupId', sql.UniqueIdentifier, groupId);

      const result = await request.query(`
        SELECT 
          ${selectColumns}
        FROM oe.GroupContributions
        WHERE GroupId = @groupId
          AND Status = 'Active'
          AND EffectiveDate <= GETDATE()
          AND (EndDate IS NULL OR EndDate >= GETDATE())
        ORDER BY Priority, Name
      `);

      // Ensure missing columns set; support ProductIds (multi) with ProductId (single) fallback
      const rules = result.recordset.map(rule => {
        let productIds = [];
        if (productIdsColumnExists && rule.ProductIds) {
          try {
            productIds = Array.isArray(rule.ProductIds) ? rule.ProductIds : JSON.parse(rule.ProductIds || '[]');
          } catch (_) {
            productIds = [];
          }
        }
        if (productIds.length === 0 && rule.ProductId) {
          productIds = [rule.ProductId];
        }
        return {
          ...rule,
          ProductId: productIds.length === 1 ? productIds[0] : (rule.ProductId || null),
          _productIdsArray: productIds,
          AgeRules: ageRulesColumnExists ? rule.AgeRules : null,
          JobPositions: jobPositionsColumnExists ? rule.JobPositions : null,
          EquivalentTier: equivalentTierColumnExists
            ? (rule.EquivalentTier != null && String(rule.EquivalentTier).trim() !== ''
              ? String(rule.EquivalentTier).trim().toUpperCase()
              : null)
            : null
        };
      });

      await this.enrichRulesWithBundleProductIds(rules, pool);
      return rules;

    } catch (error) {
      console.error(`Error fetching contribution rules for group ${groupId}:`, error);
      throw new Error(`Failed to fetch contribution rules: ${error.message}`);
    }
  }

  /**
   * Check if a rule applies to the member
   * @param {Object} rule - Contribution rule
   * @param {Object} memberCriteria - Member criteria
   * @returns {boolean} True if rule applies
   */
  static ruleAppliesToMember(rule, memberCriteria) {
    // Check job position filter first (if rule has JobPositions filter)
    if (rule.JobPositions) {
      try {
        const jobPositions = typeof rule.JobPositions === 'string' 
          ? JSON.parse(rule.JobPositions) 
          : rule.JobPositions;
        
        // If job positions array exists and has items, member must match
        if (Array.isArray(jobPositions) && jobPositions.length > 0) {
          const memberJobPosition = memberCriteria.jobPosition || memberCriteria.JobPosition;
          
          console.log(`🔍 DEBUG ruleAppliesToMember - Job Position Check:`, {
            ruleName: rule.Name,
            ruleJobPositions: jobPositions,
            memberJobPosition: memberJobPosition,
            memberCriteria: memberCriteria,
            matches: memberJobPosition && jobPositions.includes(memberJobPosition)
          });
          
          if (!memberJobPosition || !jobPositions.includes(memberJobPosition)) {
            console.log(`❌ Rule ${rule.Name} does NOT apply - job position mismatch:`, {
              memberJobPosition,
              ruleJobPositions: jobPositions
            });
            return false; // Member's job position doesn't match filter
          }
          
          console.log(`✅ Rule ${rule.Name} job position matches:`, memberJobPosition);
        }
        // If empty array or null, applies to all job positions (fall through)
      } catch (error) {
        console.warn(`Error parsing rule JobPositions: ${error.message}`);
        // Continue to other checks if parsing fails
      }
    }

    // Check AppliesTo restrictions
    if (!rule.AppliesTo) {
      return true; // Rule applies to all members if no restrictions
    }

    try {
      const appliesTo = typeof rule.AppliesTo === 'string' ? JSON.parse(rule.AppliesTo) : rule.AppliesTo;

      // Check coverage tier restriction
      if (appliesTo.coverageTier && !appliesTo.coverageTier.includes(memberCriteria.tier)) {
        return false;
      }

      // Check employment class restriction
      if (appliesTo.employmentClass && memberCriteria.employmentClass) {
        if (!appliesTo.employmentClass.includes(memberCriteria.employmentClass)) {
          return false;
        }
      }

      // Add other restriction checks as needed

      return true;

    } catch (error) {
      console.warn(`Error parsing rule AppliesTo: ${error.message}`);
      return true; // Default to applying the rule if parsing fails
    }
  }

  /**
   * Get tier-based contribution amount
   * @param {Object} rule - Contribution rule
   * @param {string} tier - Coverage tier
   * @returns {number} Contribution amount
   */
  static getTierContribution(rule, tier) {
    if (!rule.TierContributions) {
      console.warn(`⚠️ getTierContribution: No TierContributions in rule ${rule.Name || rule.ContributionId}`);
      return 0;
    }

    try {
      const tierContributions = typeof rule.TierContributions === 'string' 
        ? JSON.parse(rule.TierContributions) 
        : rule.TierContributions;

      console.log(`🔍 DEBUG: getTierContribution parsing for tier=${tier}:`, {
        ruleName: rule.Name || rule.ContributionId,
        tierContributionsKeys: Object.keys(tierContributions),
        tierContributionsValues: tierContributions
      });

      // Check for exact tier match first (e.g., "EF")
      if (tierContributions[tier] !== undefined) {
        const amount = Number(tierContributions[tier]) || 0;
        console.log(`✅ Found exact tier match: tier=${tier}, amount=${amount}`);
        return amount;
      }

      // Check for full name matches (e.g., "family" for EF tier)
      const tierMappings = {
        'EE': ['employee_only', 'employee'],
        'ES': ['employee_spouse'],
        'EC': ['employee_children'],
        'EF': ['family', 'employee_family']
      };

      const possibleKeys = tierMappings[tier] || [];
      for (const key of possibleKeys) {
        if (tierContributions[key] !== undefined) {
          const amount = Number(tierContributions[key]) || 0;
          console.log(`✅ Found tier mapping match: tier=${tier} -> key="${key}", amount=${amount}`);
          return amount;
        }
      }

      console.warn(`⚠️ getTierContribution: No match found for tier=${tier} in rule ${rule.Name || rule.ContributionId}. Available keys: ${Object.keys(tierContributions).join(', ')}`);
      return 0;

    } catch (error) {
      console.error(`❌ Error parsing tier contributions for tier=${tier}:`, error.message);
      return 0;
    }
  }

  /**
   * Get age-based contribution amount
   * @param {Object} rule - Contribution rule
   * @param {number} memberAge - Member's current age
   * @param {number} premium - Premium amount (for percentage calculations)
   * @returns {number} Contribution amount
   */
  static getAgeContribution(rule, memberAge, premium = 0) {
    if (!rule.AgeRules || memberAge === null || memberAge === undefined) {
      console.log(`🔍 DEBUG getAgeContribution: No AgeRules or memberAge for rule "${rule.Name}", memberAge=${memberAge}`);
      return 0;
    }

    try {
      const ageRules = typeof rule.AgeRules === 'string' 
        ? JSON.parse(rule.AgeRules) 
        : rule.AgeRules;

      console.log(`🔍 DEBUG getAgeContribution for rule "${rule.Name}":`, {
        memberAge,
        ageRulesCount: ageRules?.length || 0,
        ageRules: ageRules
      });

      if (!Array.isArray(ageRules) || ageRules.length === 0) {
        console.log(`🔍 DEBUG getAgeContribution: No age rules array for rule "${rule.Name}"`);
        return 0;
      }

      // Find the applicable age rule (first matching rule)
      // If multiple rules match, use the first one found
      const applicableRule = ageRules.find(ageRule => {
        const minAge = Number(ageRule.minAge) || 0;
        const maxAge = ageRule.maxAge !== null && ageRule.maxAge !== undefined 
          ? Number(ageRule.maxAge) 
          : null;
        
        // Check if member age falls within the range
        if (maxAge !== null) {
          const matches = memberAge >= minAge && memberAge <= maxAge;
          console.log(`🔍 DEBUG getAgeContribution: Checking age rule ${minAge}-${maxAge} for age ${memberAge}: ${matches ? 'MATCH' : 'NO MATCH'}`);
          return matches;
        } else {
          // No max age means applies to all ages >= minAge
          const matches = memberAge >= minAge;
          console.log(`🔍 DEBUG getAgeContribution: Checking age rule ${minAge}+ for age ${memberAge}: ${matches ? 'MATCH' : 'NO MATCH'}`);
          return matches;
        }
      });

      if (!applicableRule) {
        console.log(`🔍 DEBUG getAgeContribution: No matching age rule for rule "${rule.Name}", memberAge=${memberAge}`);
        return 0; // No matching age rule
      }

      const contributionAmount = Number(applicableRule.contributionAmount) || 0;
      const contributionType = applicableRule.contributionType || 'flat';
      
      console.log(`🔍 DEBUG getAgeContribution: Found applicable rule for "${rule.Name}":`, {
        minAge: applicableRule.minAge,
        maxAge: applicableRule.maxAge,
        contributionAmount,
        contributionType,
        premium
      });
      
      // Calculate contribution based on type
      if (contributionType === 'percentage') {
        // Percentage of premium
        const result = premium * (contributionAmount / 100);
        console.log(`🔍 DEBUG getAgeContribution: Percentage calculation: ${premium} * (${contributionAmount} / 100) = ${result}`);
        return result;
      } else {
        // Flat amount
        console.log(`🔍 DEBUG getAgeContribution: Flat amount: ${contributionAmount}`);
        return contributionAmount;
      }

    } catch (error) {
      console.warn(`Error parsing age rules: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get role-based contribution amount
   * @param {Object} rule - Contribution rule
   * @param {Object} memberCriteria - Member criteria
   * @returns {number} Contribution amount
   */
  static getRoleContribution(rule, memberCriteria) {
    if (!rule.RoleContributions || !memberCriteria.role) {
      return 0;
    }

    try {
      const roleContributions = typeof rule.RoleContributions === 'string' 
        ? JSON.parse(rule.RoleContributions) 
        : rule.RoleContributions;

      return Number(roleContributions[memberCriteria.role]) || 0;

    } catch (error) {
      console.warn(`Error parsing role contributions: ${error.message}`);
      return 0;
    }
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

module.exports = ContributionCalculator;
