/**
 * CONTRIBUTION CALCULATOR - Frontend contribution calculation service
 * 
 * Handles all contribution calculations for products, bundles, and all-products rules
 * Used by: EnrollmentWizard for real-time contribution calculations
 */

export interface ContributionRule {
  type: string;
  amount: number;
  description: string;
  appliesTo: string;
  contributionDirection?: 'Employer' | 'MaxEmployee'; // NEW: Direction of contribution
  /** When type is percentage: use this tier's equivalent premium as base (EE, ES, EC, EF) */
  equivalentTier?: 'EE' | 'ES' | 'EC' | 'EF' | null;
  // Tier-based contributions (for tier_based type)
  tierContributions?: {
    EE?: number;
    ES?: number;
    EC?: number;
    EF?: number;
    employee_only?: number;
    employee_spouse?: number;
    employee_children?: number;
    family?: number;
    employee_family?: number;
  };
  // Age-based contributions (for age_based type)
  ageRules?: Array<{
    minAge: number;
    maxAge: number | null;
    contributionAmount: number;
    contributionType: 'flat' | 'percentage';
  }>;
  // Job position filter
  jobPositions?: string[];
  // Tenure-based rules
  tenureRules?: Array<{
    minTenure: number;
    maxTenure: number | null;
    contributionAmount: number;
    contributionType: 'flat' | 'percentage';
  }>;
  // Role-based contributions
  roleContributions?: Record<string, number>;
  // Rule metadata
  priority?: number;
  stacking?: boolean;
  appliesToRestrictions?: {
    coverageTier?: string[];
    employmentClass?: string[];
    planType?: string[];
  };
}

export interface PricingVariation {
  configValue: string;
  monthlyPremium: number;
  netRate?: number;
  overrideRate?: number;
  msrpRate?: number;
  tierType?: string;
  tobaccoStatus?: string;
}

export interface Product {
  productId: string;
  productName: string;
  description?: string;
  productType?: string;
  isBundle: boolean;
  contributionRules: ContributionRule[];
  pricingVariations: PricingVariation[];
  /** When group has percentage + equivalentTier rules: premiums by tier (EE, ES, EC, EF) */
  equivalentPremiums?: Partial<Record<'EE' | 'ES' | 'EC' | 'EF', number>>;
  includedProducts?: Array<{
    productId: string;
    productName: string;
    pricingVariations: PricingVariation[];
  }>;
}

export interface ContributionResult {
  employer: number;
  employee: number;
}

export interface ProductContributionResult extends ContributionResult {
  productId: string;
  productName: string;
  selectedConfig?: string;
  appliedRules: ContributionRule[];
}

export interface AllProductsContributionResult extends ContributionResult {
  appliedRules: ContributionRule[];
}

export class ContributionCalculator {
  /**
   * Calculate contributions for a specific product with selected configuration
   * @param product - Product with contribution rules and pricing variations
   * @param selectedConfig - Selected configuration value
   * @param memberTier - Member tier (EE, ES, EC, EF) for tier-based calculations
   * @param memberCriteria - Member criteria (age, jobPosition) for filtering rules
   * @returns Contribution result with applied rules
   */
  static calculateProductContributions(
    product: Product, 
    selectedConfig: string,
    memberTier?: string,
    memberCriteria?: { age?: number; jobPosition?: string }
  ): ProductContributionResult {
    // Handle bundles by computing premium from includedProducts for the selected config
    if (product.isBundle && product.includedProducts && product.includedProducts.length > 0) {
      // Use selectedConfig, or product.defaultConfig, or first available config - never 'Default'
      let configToUse = selectedConfig;
      if (!configToUse || configToUse === 'Default') {
        // Try to get default from product metadata
        const productWithMetadata = product as any;
        configToUse = productWithMetadata.defaultConfig || 
                     (productWithMetadata.availableConfigs && productWithMetadata.availableConfigs.length > 0 
                       ? productWithMetadata.availableConfigs[0] 
                       : null) ||
                     (product.includedProducts[0]?.pricingVariations && product.includedProducts[0].pricingVariations.length > 0 
                       ? product.includedProducts[0].pricingVariations[0].configValue 
                       : null);
      }
      
      if (!configToUse) {
        console.warn(`⚠️ No config found for bundle ${product.productId}, using first available`);
        const fallbackConfig = product.includedProducts[0]?.pricingVariations?.[0]?.configValue;
        configToUse = fallbackConfig || '';
      }
      
      const normalizedSelected = String(configToUse);
      let monthlyPremium = 0;

      product.includedProducts.forEach((included: any) => {
        let includedPremium = 0;
        if (included.pricingVariations && included.pricingVariations.length > 0) {
          const match = included.pricingVariations.find(
            (v: any) => String(v.configValue) === normalizedSelected
          );
          const variation = match || included.pricingVariations[0];
          includedPremium = Number(variation.monthlyPremium || 0);
        } else {
          includedPremium = Number((included as any).monthlyPremium || 0);
        }
        monthlyPremium += includedPremium;
      });

      console.log(`💼 ContributionCalculator: bundle premium for ${product.productId} (${normalizedSelected}) =`, monthlyPremium);

      const productRules = this.filterApplicableRules(
        (product.contributionRules || []).filter(rule => rule.appliesTo === 'product'),
        memberCriteria
      );
        const contribution = this.applyRulesToPremium(monthlyPremium, productRules, memberTier, memberCriteria, (product as Product).equivalentPremiums);

      return {
        productId: product.productId,
        productName: product.productName,
        selectedConfig: normalizedSelected,
        employer: contribution.employer,
        employee: contribution.employee,
        appliedRules: productRules
      };
    }

    // Non-bundles: use product.pricingVariations / monthlyPremium directly
    const pricingVariations = product.pricingVariations || [];

    // Find the pricing variation for the selected config
    let variation = pricingVariations.find(v => v.configValue === selectedConfig);

    // If no matching variation found, try to use the first available variation or base premium
    if (!variation) {
      if (pricingVariations.length > 0) {
        variation = pricingVariations[0];
        console.log(`⚠️ Using first pricing variation for product ${product.productId} (config "${selectedConfig}" not found)`);
      } else {
        // Product has no pricing variations - use monthlyPremium directly from product
        const monthlyPremium = (product as any).monthlyPremium || 0;
        console.log(`⚠️ Product ${product.productId} has no pricing variations, using base monthlyPremium: $${monthlyPremium}`);

        const productRules = this.filterApplicableRules(
          (product.contributionRules || []).filter(rule => rule.appliesTo === 'product'),
          memberCriteria
        );
        const contribution = this.applyRulesToPremium(monthlyPremium, productRules, memberTier, memberCriteria, (product as Product).equivalentPremiums);

        return {
          productId: product.productId,
          productName: product.productName,
          selectedConfig,
          employer: contribution.employer,
          employee: contribution.employee,
          appliedRules: productRules
        };
      }
    }

    const productRules = this.filterApplicableRules(
      (product.contributionRules || []).filter(rule => rule.appliesTo === 'product'),
      memberCriteria
    );
    const contribution = this.applyRulesToPremium(variation.monthlyPremium, productRules, memberTier, memberCriteria, product.equivalentPremiums);

    return {
      productId: product.productId,
      productName: product.productName,
      selectedConfig,
      employer: contribution.employer,
      employee: contribution.employee,
      appliedRules: productRules
    };
  }

  /**
   * Calculate all-products contributions for remaining premium
   * @param remainingPremium - Premium after product-specific contributions
   * @param allProductsRules - Rules that apply to remaining premium
   * @param memberTier - Member tier (EE, ES, EC, EF) for tier-based calculations
   * @param memberCriteria - Member criteria (age, jobPosition) for filtering rules
   * @returns Contribution result with applied rules
   */
  static calculateAllProductsContributions(
    remainingPremium: number,
    allProductsRules: ContributionRule[],
    memberTier?: string,
    memberCriteria?: { age?: number; jobPosition?: string }
  ): AllProductsContributionResult {
    console.log('🔍 DEBUG calculateAllProductsContributions:', {
      remainingPremium,
      totalRules: allProductsRules.length,
      memberTier,
      memberCriteria
    });

    if (allProductsRules.length === 0) {
      console.log('⚠️ No all-products rules to apply');
      return {
        employer: 0,
        employee: remainingPremium,
        appliedRules: []
      };
    }

    // Filter rules by member criteria
    const applicableRules = this.filterApplicableRules(allProductsRules, memberCriteria);
    
    console.log('🔍 DEBUG calculateAllProductsContributions: After filtering:', {
      applicableRulesCount: applicableRules.length,
      applicableRules: applicableRules.map(r => ({
        description: r.description,
        type: r.type,
        contributionDirection: r.contributionDirection
      }))
    });
    
    const contribution = this.applyRulesToPremium(remainingPremium, applicableRules, memberTier, memberCriteria);
    
    console.log('🔍 DEBUG calculateAllProductsContributions: Result:', {
      employer: contribution.employer,
      employee: contribution.employee,
      remainingPremium
    });
    
    return {
      employer: contribution.employer,
      employee: contribution.employee,
      appliedRules: applicableRules
    };
  }

  /**
   * Calculate total contributions for all selected products
   * @param products - Array of products with selected configurations
   * @param selectedConfigs - Map of productId to selected config
   * @param allProductsRules - Rules that apply to remaining premium
   * @param memberTier - Member tier (EE, ES, EC, EF) for tier-based calculations
   * @param memberCriteria - Member criteria (age, jobPosition) for filtering rules
   * @returns Complete contribution breakdown
   */
  static calculateTotalContributions(
    products: Product[],
    selectedConfigs: Record<string, string>,
    allProductsRules: ContributionRule[],
    memberTier?: string,
    memberCriteria?: { age?: number; jobPosition?: string }
  ): {
    productContributions: ProductContributionResult[];
    allProductsContribution: AllProductsContributionResult;
    totals: {
      totalPremium: number;
      totalEmployerContribution: number;
      totalEmployeeContribution: number;
    };
  } {
    // Calculate contributions for each product
    // CRITICAL: Only process products that are actually selected (have an entry in selectedConfigs)
    const productContributions: ProductContributionResult[] = [];
    let totalProductSpecificEmployer = 0;
    let totalPremium = 0;

    for (const product of products) {
      // Skip products that are not selected - only process products in selectedConfigs
      if (!selectedConfigs[product.productId]) {
        console.log(`⏭️ Skipping product ${product.productId} (${product.productName}) - not selected`);
        continue;
      }
      
      // Use selectedConfig, or product.defaultConfig, or first available config - never 'Default'
      let selectedConfig = selectedConfigs[product.productId];
      if (!selectedConfig || selectedConfig === 'Default') {
        const productWithMetadata = product as any;
        selectedConfig = productWithMetadata.defaultConfig || 
                        (productWithMetadata.availableConfigs && productWithMetadata.availableConfigs.length > 0 
                          ? productWithMetadata.availableConfigs[0] 
                          : null) ||
                        (product.pricingVariations && product.pricingVariations.length > 0 
                          ? product.pricingVariations[0].configValue 
                          : null);
      }
      
      if (!selectedConfig) {
        console.warn(`⚠️ No config found for product ${product.productId}, using fallback`);
        selectedConfig = 'Default'; // Last resort fallback
      }
      
      // Only apply product-specific contribution rules to selected products
      const contribution = this.calculateProductContributions(product, selectedConfig, memberTier, memberCriteria);
      productContributions.push(contribution);
      
      totalProductSpecificEmployer += contribution.employer;
      totalPremium += contribution.employer + contribution.employee;
    }

    // Filter all-products rules by member criteria (job position, age)
    const applicableAllProductsRules = this.filterApplicableRules(allProductsRules, memberCriteria);

    // Calculate remaining premium for all-products rules
    const remainingPremium = totalPremium - totalProductSpecificEmployer;
    const allProductsContribution = this.calculateAllProductsContributions(remainingPremium, applicableAllProductsRules, memberTier, memberCriteria);

    // Calculate final totals
    const totalEmployerContribution = totalProductSpecificEmployer + allProductsContribution.employer;
    const totalEmployeeContribution = Math.max(0, totalPremium - totalEmployerContribution); // Cap at 0

    return {
      productContributions,
      allProductsContribution,
      totals: {
        totalPremium,
        totalEmployerContribution,
        totalEmployeeContribution
      }
    };
  }

  /**
   * Adjust employer contribution for MaxEmployee rules when processing fees are added
   * For MaxEmployee rules: Employee pays at most the max amount, so processing fees should be covered by employer
   * @param originalEmployerContribution - Original employer contribution amount
   * @param originalEmployeeContribution - Original employee contribution amount
   * @param processingFees - Processing fees to be added
   * @param hasMaxEmployeeRule - Whether any MaxEmployee rules are active
   * @returns Adjusted contribution amounts
   */
  static adjustContributionsForProcessingFees(
    originalEmployerContribution: number,
    originalEmployeeContribution: number,
    processingFees: number,
    hasMaxEmployeeRule: boolean
  ): {
    adjustedEmployerContribution: number;
    adjustedEmployeeContribution: number;
  } {
    if (!hasMaxEmployeeRule || processingFees === 0) {
      // No adjustment needed for regular rules or when no processing fees
      return {
        adjustedEmployerContribution: originalEmployerContribution,
        adjustedEmployeeContribution: originalEmployeeContribution + processingFees
      };
    }

    // For MaxEmployee rules: Employee pays at most their max amount
    // Processing fees should be covered by employer contribution if the rule is a MaxEmployee rule
    // Employee contribution stays the same (already at max)
    // Employer contribution increases by processing fees amount
    return {
      adjustedEmployerContribution: originalEmployerContribution + processingFees,
      adjustedEmployeeContribution: originalEmployeeContribution // Employee still pays the max, no change
    };
  }

  /**
   * Filter contribution rules by member criteria (job position, age)
   * @param rules - Array of contribution rules
   * @param memberCriteria - Member criteria (age, jobPosition)
   * @returns Filtered rules that apply to this member
   */
  private static filterApplicableRules(
    rules: ContributionRule[],
    memberCriteria?: { age?: number; jobPosition?: string }
  ): ContributionRule[] {
    if (!memberCriteria) {
      console.log('🔍 DEBUG filterApplicableRules: No memberCriteria, returning all rules:', rules.length);
      return rules;
    }

    console.log('🔍 DEBUG filterApplicableRules: Filtering rules with memberCriteria:', {
      age: memberCriteria.age,
      jobPosition: memberCriteria.jobPosition,
      totalRules: rules.length
    });

    const filtered = rules.filter(rule => {
      // Filter by job position
      if (rule.jobPositions && rule.jobPositions.length > 0) {
        if (!memberCriteria.jobPosition || !rule.jobPositions.includes(memberCriteria.jobPosition)) {
          console.log(`❌ Rule "${rule.description}" filtered out - job position mismatch:`, {
            ruleJobPositions: rule.jobPositions,
            memberJobPosition: memberCriteria.jobPosition
          });
          return false; // Rule doesn't apply to this job position
        } else {
          console.log(`✅ Rule "${rule.description}" passed job position filter`);
        }
      }

      // Filter by age (for age_based rules)
      if (rule.type === 'age_based' && rule.ageRules && rule.ageRules.length > 0) {
        if (memberCriteria.age === undefined) {
          console.log(`❌ Rule "${rule.description}" filtered out - no member age provided`);
          return false; // Can't apply age-based rule without age
        }
        // Check if any age rule matches
        const hasMatchingAgeRule = rule.ageRules.some(ageRule => {
          const age = memberCriteria.age!;
          const minAge = ageRule.minAge;
          const maxAge = ageRule.maxAge;
          const matches = age >= minAge && (maxAge === null || maxAge === undefined || age <= maxAge);
          if (matches) {
            console.log(`✅ Rule "${rule.description}" age rule matches:`, {
              memberAge: age,
              ruleRange: `${minAge}-${maxAge || '∞'}`,
              contributionAmount: ageRule.contributionAmount,
              contributionType: ageRule.contributionType
            });
          }
          return matches;
        });
        if (!hasMatchingAgeRule) {
          console.log(`❌ Rule "${rule.description}" filtered out - no matching age rule:`, {
            memberAge: memberCriteria.age,
            ageRules: rule.ageRules.map(ar => `${ar.minAge}-${ar.maxAge || '∞'}`)
          });
          return false; // No age rule matches
        }
      }

      console.log(`✅ Rule "${rule.description}" passed all filters`);
      return true; // Rule applies
    });

    console.log(`🔍 DEBUG filterApplicableRules: ${filtered.length} of ${rules.length} rules passed filtering`);
    return filtered;
  }

  /**
   * Apply contribution rules to a premium amount
   * @param premium - Premium amount to apply rules to
   * @param rules - Array of contribution rules to apply (should already be filtered)
   * @param memberTier - Member tier (EE, ES, EC, EF) for tier-based calculations
   * @param memberCriteria - Member criteria (age, jobPosition) for age-based calculations
   * @returns Contribution result
   */
  private static applyRulesToPremium(
    premium: number,
    rules: ContributionRule[],
    memberTier?: string,
    memberCriteria?: { age?: number; jobPosition?: string },
    equivalentPremiums?: Partial<Record<'EE' | 'ES' | 'EC' | 'EF', number>>
  ): ContributionResult {
    console.log('🔍 DEBUG applyRulesToPremium:', {
      premium,
      rulesCount: rules.length,
      memberTier,
      memberCriteria
    });

    if (rules.length === 0) {
      console.log('⚠️ applyRulesToPremium: No rules to apply, returning employer: 0');
      return { employer: 0, employee: premium };
    }

    // For now, apply the first applicable rule
    // In the future, we could support multiple rules with stacking logic
    const rule = rules[0];
    console.log(`🔍 DEBUG applyRulesToPremium: Applying first rule "${rule.description}":`, {
      type: rule.type,
      contributionDirection: rule.contributionDirection,
      amount: rule.amount
    });
    
    const result = this.applyRule(premium, rule, memberTier, memberCriteria, equivalentPremiums);
    
    console.log('🔍 DEBUG applyRulesToPremium: Result:', {
      employer: result.employer,
      employee: result.employee,
      premium
    });
    
    return result;
  }

  /**
   * Apply a single contribution rule to a premium amount
   * @param premium - Premium amount
   * @param rule - Contribution rule to apply
   * @param memberTier - Member tier (EE, ES, EC, EF) for tier-based calculations
   * @param memberCriteria - Member criteria (age, jobPosition) for age-based calculations
   * @returns Contribution result
   */
  private static applyRule(
    premium: number,
    rule: ContributionRule,
    memberTier?: string,
    memberCriteria?: { age?: number; jobPosition?: string },
    equivalentPremiums?: Partial<Record<'EE' | 'ES' | 'EC' | 'EF', number>>
  ): ContributionResult {
    const direction = rule.contributionDirection || 'Employer'; // Default to 'Employer' for backward compatibility
    
    console.log(`🔍 DEBUG applyRule: Applying rule "${rule.description}":`, {
      type: rule.type,
      direction,
      amount: rule.amount,
      premium,
      memberTier,
      memberCriteria,
      hasAgeRules: !!(rule.ageRules && rule.ageRules.length > 0),
      ageRules: rule.ageRules
    });
    
    switch (rule.type) {
      case 'flat_rate':
        if (direction === 'MaxEmployee') {
          // Max Employee Contribution: Employee pays up to the amount, employer covers the rest
          const employeeAmount = Math.min(rule.amount, premium);
          return {
            employer: Math.max(0, premium - employeeAmount),
            employee: employeeAmount
          };
        } else {
          // Employer Contribution (default): Employer pays the amount, employee pays the rest
          const employerAmount = rule.amount; // Allow over-contributions
          return {
            employer: employerAmount,
            employee: Math.max(0, premium - employerAmount) // Cap employee contribution at 0
          };
        }

      case 'percentage': {
        const basePremium = (rule.equivalentTier && equivalentPremiums && equivalentPremiums[rule.equivalentTier] != null)
          ? equivalentPremiums[rule.equivalentTier]!
          : premium;
        const contributionAmount = Math.min(basePremium * (rule.amount / 100), premium);
        if (direction === 'MaxEmployee') {
          const employeeAmount = Math.min(contributionAmount, premium);
          return {
            employer: Math.max(0, premium - employeeAmount),
            employee: employeeAmount
          };
        } else {
          return {
            employer: contributionAmount,
            employee: Math.max(0, premium - contributionAmount)
          };
        }
      }

      case 'tier_based':
        // Get tier-specific contribution amount
        const tierContribution = this.getTierContribution(rule, memberTier);
        if (direction === 'MaxEmployee') {
          // Max Employee Contribution: Employee pays up to the tier amount, employer covers the rest
          const employeeAmount = Math.min(tierContribution, premium);
          return {
            employer: Math.max(0, premium - employeeAmount),
            employee: employeeAmount
          };
        } else {
          // Employer Contribution (default): Employer pays the tier amount, employee pays the rest
          return {
            employer: tierContribution,
            employee: Math.max(0, premium - tierContribution) // Cap employee contribution at 0
          };
        }

      case 'age_based':
        // Age-based contributions - calculate based on member age
        if (!memberCriteria || memberCriteria.age === undefined) {
          console.warn('Age-based contributions require member age');
          return { employer: 0, employee: premium };
        }

        if (!rule.ageRules || rule.ageRules.length === 0) {
          console.warn('Age-based rule has no ageRules defined');
          return { employer: 0, employee: premium };
        }

        // Find matching age rule
        const age = memberCriteria.age;
        const matchingAgeRule = rule.ageRules.find(ageRule => {
          const minAge = ageRule.minAge;
          const maxAge = ageRule.maxAge;
          return age >= minAge && (maxAge === null || maxAge === undefined || age <= maxAge);
        });

        if (!matchingAgeRule) {
          console.warn(`No matching age rule for age ${age}`);
          return { employer: 0, employee: premium };
        }

        // Calculate contribution based on age rule
        let contributionAmount = 0;
        if (matchingAgeRule.contributionType === 'flat') {
          contributionAmount = matchingAgeRule.contributionAmount;
        } else if (matchingAgeRule.contributionType === 'percentage') {
          contributionAmount = premium * (matchingAgeRule.contributionAmount / 100);
        }

        if (direction === 'MaxEmployee') {
          // Max Employee Contribution: Employee pays up to the amount, employer covers the rest
          const employeeAmount = Math.min(contributionAmount, premium);
          return {
            employer: Math.max(0, premium - employeeAmount),
            employee: employeeAmount
          };
        } else {
          // Employer Contribution (default): Employer pays the amount, employee pays the rest
          return {
            employer: contributionAmount,
            employee: Math.max(0, premium - contributionAmount) // Cap employee contribution at 0
          };
        }

      default:
        console.warn(`Unknown contribution rule type: ${rule.type}`);
        return { employer: 0, employee: premium };
    }
  }

  /**
   * Get tier-based contribution amount from rule
   * @param rule - Contribution rule with tierContributions
   * @param tier - Coverage tier (EE, ES, EC, EF)
   * @returns Contribution amount for this tier
   */
  private static getTierContribution(rule: ContributionRule, tier?: string): number {
    if (!rule.tierContributions || !tier) {
      return 0;
    }

    const tierContributions = rule.tierContributions;

    // Check for exact tier match first (EE, ES, EC, EF)
    if (tierContributions[tier as keyof typeof tierContributions] !== undefined) {
      return Number(tierContributions[tier as keyof typeof tierContributions]) || 0;
    }

    // Check for full name matches (employee_only, employee_spouse, etc.)
    const tierMappings: Record<string, string[]> = {
      'EE': ['employee_only', 'employee'],
      'ES': ['employee_spouse'],
      'EC': ['employee_children'],
      'EF': ['family', 'employee_family']
    };

    const possibleKeys = tierMappings[tier] || [];
    for (const key of possibleKeys) {
      if (tierContributions[key as keyof typeof tierContributions] !== undefined) {
        return Number(tierContributions[key as keyof typeof tierContributions]) || 0;
      }
    }

    return 0;
  }

  /**
   * Get contribution breakdown for display purposes
   * @param contribution - Contribution result
   * @returns Formatted breakdown string
   */
  static getContributionBreakdown(contribution: ContributionResult): string {
    const total = contribution.employer + contribution.employee;
    if (total === 0) return 'No contribution';
    
    const employerPercentage = ((contribution.employer / total) * 100).toFixed(1);
    return `Employer: $${contribution.employer.toFixed(2)} (${employerPercentage}%), Employee: $${contribution.employee.toFixed(2)}`;
  }

  /**
   * Validate contribution rules
   * @param rules - Array of contribution rules
   * @returns Validation result
   */
  static validateRules(rules: ContributionRule[]): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const rule of rules) {
      if (!rule.type) {
        errors.push('Rule type is required');
      }
      
      if (rule.amount < 0) {
        errors.push('Rule amount cannot be negative');
      }

      if (rule.type === 'percentage' && rule.amount > 100) {
        errors.push('Percentage amount cannot exceed 100%');
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}

export default ContributionCalculator;
