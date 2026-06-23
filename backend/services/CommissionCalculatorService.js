// backend/services/CommissionCalculatorService.js
const { getPool, sql } = require('../config/database');
const logger = require('../config/logger');

/**
 * Commission Calculator Service
 * Calculates commission payouts based on commission rules, agent hierarchy, and payment data
 * Implements stackable priority-based rules with tier distribution
 */
class CommissionCalculatorService {
  /**
   * Calculate commissions for a payment
   * @param {string} paymentId - Payment ID
   * @param {string} productId - Product ID
   * @param {number} paymentAmount - Payment amount
   * @param {string} agentId - Selling agent ID
   * @param {string} tenantId - Tenant ID
   * @param {string} enrollmentId - Enrollment ID (optional, for fallback calculation)
   * @param {number} overrideAmount - OverrideRate from oe.Payments (paid 100% to tenant/product owner)
   * @param {number} commissionAmount - Commission (Agent Commission Pool) from oe.Payments (preferred over calculation)
   * @param {number} vendorCommissionAmount - NetRate from oe.Payments (paid 100% to vendor) - NOTE: parameter name is legacy but represents NetRate
   * @returns {Promise<Object>} Commission breakdown
   */
  async calculateCommissions(paymentId, productId, paymentAmount, agentId, tenantId, enrollmentId = null, overrideAmount = 0, commissionAmount = null, vendorCommissionAmount = null, householdId = null, groupId = null, paymentDate = null, allowUnlockedRules = false, overrideAgentRuleId = null, productTier = null, enrollmentProductIds = null, productCommissionAmounts = null, productEnrollmentCounts = null, useCurrentDateForRuleEffectiveness = false, productVendorAmounts = null, productOwnerAmounts = null) {
    try {
      // Get product commission allocation
      const product = await this.getProduct(productId);
      if (!product) {
        throw new Error(`Product not found: ${productId}`);
      }

      // Get payment date from oe.Payments if paymentId is provided, otherwise use provided paymentDate or current date
      let finalPaymentDate = paymentDate;
      if (!finalPaymentDate && paymentId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('PaymentId', sql.UniqueIdentifier, paymentId);
        const paymentResult = await request.query(`
          SELECT PaymentDate, CreatedDate
          FROM oe.Payments
          WHERE PaymentId = @PaymentId
        `);
        if (paymentResult.recordset.length > 0) {
          // Use PaymentDate if available, otherwise use CreatedDate
          finalPaymentDate = paymentResult.recordset[0].PaymentDate || paymentResult.recordset[0].CreatedDate;
        }
      }
      // Fallback to current date if still not set
      if (!finalPaymentDate) {
        finalPaymentDate = new Date();
      }

      // Use values from oe.Payments if provided (preferred), otherwise calculate dynamically
      // vendorCommissionAmount parameter represents NetRate (what vendor gets - 100% of NetRate)
      let finalVendorCommissionAmount = vendorCommissionAmount;
      if (finalVendorCommissionAmount === null || finalVendorCommissionAmount === undefined) {
        // Fallback: Get NetRate from ProductPricing if enrollment info available
        // Scale proportionally to payment amount if enrollment premium differs
        if (enrollmentId) {
          // Get enrollment premium for proportional scaling
          const pool = await getPool();
          const enrollRequest = pool.request();
          enrollRequest.input('EnrollmentId', sql.UniqueIdentifier, enrollmentId);
          const enrollResult = await enrollRequest.query(`
            SELECT PremiumAmount
            FROM oe.Enrollments
            WHERE EnrollmentId = @EnrollmentId
          `);
          const enrollmentPremium = enrollResult.recordset.length > 0 
            ? Number(enrollResult.recordset[0].PremiumAmount) || null 
            : null;
          
          finalVendorCommissionAmount = await this.getVendorCommissionFromPricing(
            enrollmentId, 
            productId, 
            paymentAmount, 
            enrollmentPremium
          );
        } else {
          finalVendorCommissionAmount = 0;
        }
      }

      // Use Commission (Agent Commission Pool) from oe.Payments if provided, otherwise calculate from product
      let totalCommissionAllocation = commissionAmount;
      if (totalCommissionAllocation === null || totalCommissionAllocation === undefined) {
        // Fallback: Calculate from product (this is the "Commission" field from pricing, not NetRate)
        // Note: 0 is a valid value (means no commission allocated), so don't fallback when commissionAmount is 0
        totalCommissionAllocation = this.getProductCommissionAllocation(product, paymentAmount);
      }

      // Get applicable commission rules
      // Rule effectiveness: EffectiveDate <= date and (TerminationDate IS NULL or TerminationDate >= date). Date = payment date (PaymentDate or CreatedDate) when useCurrentDateForRuleEffectiveness is false; otherwise current date.
      // useCurrentDateForRuleEffectiveness: false = use payment date (correct for commission generation and simulation)
      // useCurrentDateForRuleEffectiveness: true = use current date (only when explicitly needed)
      // allowUnlockedRules: true for simulation, false for production (only locked rules apply)
      // enrollmentProductIds: ProductIds from enrollments (component products, not bundle IDs)
      // Resolve commission group. If the agent (and upline/agency) has no group assigned,
      // treat as "no agent commission rules" rather than hard-failing so the simulator/generator
      // can still distribute vendor + override payouts and produce a meaningful breakdown.
      let commissionGroupId = null;
      let applicableRules = [];
      try {
        commissionGroupId = await this.resolveCommissionGroupId(agentId, tenantId);
      } catch (cgErr) {
        logger.warn('No Commission Group resolved; continuing with empty rule set', {
          agentId,
          tenantId,
          error: cgErr.message
        }, 'Commission');
        console.warn('⚠️ Commission: No Commission Group assigned for agent; proceeding with vendor/override only. ' + cgErr.message);
      }
      if (commissionGroupId) {
        applicableRules = await this.getCommissionGroupRules(
          commissionGroupId,
          productId,
          agentId,
          tenantId,
          householdId,
          groupId,
          finalPaymentDate,
          allowUnlockedRules,
          enrollmentProductIds,
          useCurrentDateForRuleEffectiveness
        );
      }
      
      console.log('📋 Commission calculation:', {
        paymentId,
        productId,
        paymentAmount,
        commissionGroupId,
        vendorCommissionAmount: finalVendorCommissionAmount,
        overrideAmount,
        commissionAmount: totalCommissionAllocation,
        applicableRulesCount: applicableRules.length,
        rules: applicableRules.map(r => ({
          name: r.RuleName,
          type: r.EntityType,
          rate: r.CommissionRate,
          priority: r.Priority
        }))
      });

      // Calculate commission distribution
      const distribution = await this.distributeCommissions(
        applicableRules,
        agentId,
        totalCommissionAllocation,
        paymentAmount,
        product,
        finalVendorCommissionAmount,
        overrideAmount,
        householdId,
        groupId,
        overrideAgentRuleId,
        tenantId,
        productTier,
        enrollmentProductIds, // Pass enrollment ProductIds
        productCommissionAmounts, // Pass commission amounts per product
        productEnrollmentCounts, // Pass enrollment counts per product from ProductCommissions JSON
        productVendorAmounts, // Pass per-product vendor amounts for splitting vendor payouts
        productOwnerAmounts, // Pass per-product owner amounts for splitting product owner payouts
        finalPaymentDate // Pass payment date for override effective filtering
      );

      return {
        paymentId,
        productId,
        paymentAmount,
        vendorCommissionAmount: finalVendorCommissionAmount,
        totalCommissionAllocation,
        distribution: distribution.breakdown,
        totalCommissionsPaid: distribution.totalCommissionsPaid,
        remainingAmount: distribution.remainingAmount,
        overflowToProductOwner: distribution.overflowToProductOwner
      };
    } catch (error) {
      logger.error('Error calculating commissions', {
        error: error.message,
        paymentId,
        productId,
        agentId
      }, 'Commission');
      throw error;
    }
  }

  /**
   * Get product details
   * @param {string} productId - Product ID
   * @returns {Promise<Object>} Product details
   */
  async getProduct(productId) {
    const pool = await getPool();
    const request = pool.request();
    request.input('ProductId', sql.UniqueIdentifier, productId);

    const result = await request.query(`
      SELECT 
        ProductId,
        ProductOwnerId,
        VendorId,
        VendorCommission,
        CommissionStructure,
        Name as ProductName
      FROM oe.Products
      WHERE ProductId = @ProductId
        AND Status = 'Active'
    `);

    return result.recordset[0] || null;
  }

  /**
   * Get NetRate from ProductPricing for a specific enrollment
   * This is the "Vendor" field that should be paid 100% to the vendor
   * @param {string} enrollmentId - Enrollment ID
   * @param {string} productId - Product ID
   * @param {number} paymentAmount - Payment amount (for proportional scaling)
   * @param {number} enrollmentPremium - Enrollment premium amount (for proportional scaling)
   * @returns {Promise<number>} NetRate amount (scaled to payment amount if needed)
   */
  async getVendorCommissionFromPricing(enrollmentId, productId, paymentAmount = null, enrollmentPremium = null) {
    try {
      const pool = await getPool();
      const request = pool.request();
      request.input('EnrollmentId', sql.UniqueIdentifier, enrollmentId);
      request.input('ProductId', sql.UniqueIdentifier, productId);

      // PREFERRED: Get NetRate from the specific ProductPricing record referenced by the enrollment
      // This preserves historical pricing even if it becomes inactive
      const result = await request.query(`
        SELECT 
          pp.NetRate,
          e.PremiumAmount
        FROM oe.Enrollments e
        INNER JOIN oe.ProductPricing pp 
          ON e.ProductPricingId = pp.ProductPricingId
        WHERE e.EnrollmentId = @EnrollmentId
      `);

      if (result.recordset.length > 0 && result.recordset[0].NetRate !== null) {
        let netRate = Number(result.recordset[0].NetRate) || 0;
        const premium = enrollmentPremium || Number(result.recordset[0].PremiumAmount) || null;
        
        // Scale NetRate proportionally if payment amount is less than premium
        if (paymentAmount !== null && premium !== null && premium > 0 && paymentAmount < premium) {
          netRate = (netRate / premium) * paymentAmount;
          logger.info('Scaled NetRate proportionally', {
            enrollmentId,
            originalNetRate: Number(result.recordset[0].NetRate),
            premium,
            paymentAmount,
            scaledNetRate: netRate
          }, 'Commission');
        }
        
        return netRate;
      }
      
      // FALLBACK 1: Check oe.Enrollments.NetRate (snapshot value stored at enrollment time)
      const enrollRequest = pool.request();
      enrollRequest.input('EnrollmentId', sql.UniqueIdentifier, enrollmentId);
      const enrollmentResult = await enrollRequest.query(`
        SELECT NetRate, PremiumAmount
        FROM oe.Enrollments
        WHERE EnrollmentId = @EnrollmentId
          AND NetRate IS NOT NULL
          AND NetRate > 0
      `);
      
      if (enrollmentResult.recordset.length > 0) {
        let netRate = Number(enrollmentResult.recordset[0].NetRate) || 0;
        const premium = enrollmentPremium || Number(enrollmentResult.recordset[0].PremiumAmount) || null;
        
        // Scale NetRate proportionally if payment amount is less than premium
        if (paymentAmount !== null && premium !== null && premium > 0 && paymentAmount < premium) {
          netRate = (netRate / premium) * paymentAmount;
          logger.info('Scaled NetRate from enrollment snapshot proportionally', {
            enrollmentId,
            originalNetRate: Number(enrollmentResult.recordset[0].NetRate),
            premium,
            paymentAmount,
            scaledNetRate: netRate
          }, 'Commission');
        }
        
        return netRate;
      }
      
      // FALLBACK 2: If no enrollment snapshot, use active pricing (for older enrollments)
      const fallbackResult = await request.query(`
        SELECT TOP 1 NetRate
        FROM oe.ProductPricing
        WHERE ProductId = @ProductId
          AND Status = 'Active'
          AND NetRate IS NOT NULL
          AND NetRate > 0
        ORDER BY NetRate DESC
      `);
      
      if (fallbackResult.recordset.length > 0) {
        return Number(fallbackResult.recordset[0].NetRate) || 0;
      }
      
      return 0;
    } catch (error) {
      logger.error('Error getting vendor commission from pricing', {
        error: error.message,
        enrollmentId,
        productId
      }, 'Commission');
      return 0;
    }
  }

  /**
   * Calculate commission fields for a payment
   * @param {string} enrollmentId - Enrollment ID
   * @param {string} productId - Product ID
   * @param {number} paymentAmount - Payment amount
   * @returns {Promise<Object>} Object with commissionAmount, vendorCommissionAmount, overrideAmount
   */
  async calculatePaymentCommissionFields(enrollmentId, productId, paymentAmount) {
    try {
      console.log('🔍 calculatePaymentCommissionFields called:', { enrollmentId, productId, paymentAmount });
      const pool = await getPool();
      const request = pool.request();
      request.input('EnrollmentId', sql.UniqueIdentifier, enrollmentId);
      request.input('ProductId', sql.UniqueIdentifier, productId);

      // Get product details
      const product = await this.getProduct(productId);
      if (!product) {
        return { commissionAmount: 0, vendorCommissionAmount: 0, overrideAmount: 0 };
      }

      // Calculate CommissionAmount
      let commissionAmount = 0;
      if (product.CommissionStructure) {
        try {
          const commissionStruct = typeof product.CommissionStructure === 'string' 
            ? JSON.parse(product.CommissionStructure) 
            : product.CommissionStructure;
          
          if (commissionStruct.commission && typeof commissionStruct.commission === 'number') {
            if (commissionStruct.commission <= 1) {
              commissionAmount = paymentAmount * commissionStruct.commission;
            } else {
              commissionAmount = Math.min(commissionStruct.commission, paymentAmount);
            }
          }
        } catch (e) {
          // Invalid JSON, continue to next option
        }
      }

      // Fallback to VendorCommission if CommissionStructure didn't provide a value
      if (commissionAmount === 0 && product.VendorCommission && product.VendorCommission > 0) {
        if (product.VendorCommission <= 1) {
          commissionAmount = paymentAmount * product.VendorCommission;
        } else {
          commissionAmount = Math.min(product.VendorCommission, paymentAmount);
        }
      }

      // Default: 10% of payment amount if no commission structure
      if (commissionAmount === 0) {
        commissionAmount = paymentAmount * 0.10;
      }

      // Get NetRate from ProductPricing (100% goes to vendor)
      let vendorCommissionAmount = 0;
      if (enrollmentId) {
        vendorCommissionAmount = await this.getVendorCommissionFromPricing(enrollmentId, productId);
      }

      // Get OverrideAmount from ProductPricing.OverrideRate
      let overrideAmount = 0;
      const overrideResult = await request.query(`
        SELECT TOP 1 pp.OverrideRate
        FROM oe.ProductPricing pp 
        WHERE pp.ProductId = @ProductId
          AND pp.Status = 'Active'
          AND pp.OverrideRate IS NOT NULL
          AND pp.OverrideRate > 0
        ORDER BY pp.OverrideRate DESC
      `);

      if (overrideResult.recordset.length > 0 && overrideResult.recordset[0].OverrideRate) {
        // OverrideRate is a fixed dollar amount in oe.ProductPricing (e.g., $10)
        // This represents the override portion that goes to the Product Owner
        // OverrideAmount should be the same as OverrideRate - it's a fixed amount, not a percentage
        const overrideRate = overrideResult.recordset[0].OverrideRate;
        overrideAmount = overrideRate;
        console.log('💰 OverrideRate found:', overrideRate, '-> OverrideAmount:', overrideAmount);
      } else {
        console.log('⚠️ No OverrideRate found in ProductPricing');
      }

      const result = {
        commissionAmount: Math.round(commissionAmount * 100) / 100, // Round to 2 decimals
        vendorCommissionAmount: Math.round(vendorCommissionAmount * 100) / 100,
        overrideAmount: Math.round(overrideAmount * 100) / 100
      };
      console.log('✅ Commission fields calculated:', result);
      return result;
    } catch (error) {
      logger.error('Error calculating payment commission fields', {
        error: error.message,
        enrollmentId,
        productId,
        paymentAmount
      }, 'Commission');
      return { commissionAmount: 0, vendorCommissionAmount: 0, overrideAmount: 0 };
    }
  }

  /**
   * Get product commission allocation
   * Priority: CommissionStructure field > VendorCommission field > 0
   * @param {Object} product - Product object
   * @param {number} paymentAmount - Payment amount
   * @returns {number} Total commission allocation
   */
  getProductCommissionAllocation(product, paymentAmount) {
    // If CommissionStructure has a commission field, use it
    if (product.CommissionStructure) {
      try {
        const commissionStruct = typeof product.CommissionStructure === 'string' 
          ? JSON.parse(product.CommissionStructure) 
          : product.CommissionStructure;
        
        if (commissionStruct.commission && typeof commissionStruct.commission === 'number') {
          // Could be a flat amount or percentage
          if (commissionStruct.commission <= 1) {
            // Assume percentage if <= 1
            return paymentAmount * commissionStruct.commission;
          } else {
            // Flat amount
            return Math.min(commissionStruct.commission, paymentAmount);
          }
        }
      } catch (e) {
        // Invalid JSON, continue to next option
      }
    }

    // Use VendorCommission if available (assumed to be percentage)
    if (product.VendorCommission && product.VendorCommission > 0) {
      const percentage = product.VendorCommission <= 1 
        ? product.VendorCommission 
        : product.VendorCommission / 100;
      return paymentAmount * percentage;
    }

    // No commission allocated - return 0
    // This prevents making up commission amounts when none is allocated
    return 0;
  }

  /**
   * Get applicable commission rules for product/agent combination
   * Rules are ordered by Priority ASC (lower number = higher priority)
   * @param {string} productId - Product ID
   * @param {string} agentId - Agent ID
   * @param {string} tenantId - Tenant ID
   * @param {string} householdId - Household ID (optional)
   * @param {string} groupId - Group ID (optional)
   * @param {Date} paymentDate - Payment date (used to determine which rules are effective)
   * @returns {Promise<Array>} Applicable commission rules
   */
  async getApplicableRules(productId, agentId, tenantId, householdId = null, groupId = null, paymentDate = null, allowUnlockedRules = false, enrollmentProductIds = null, useCurrentDateForRuleEffectiveness = false) {
    const pool = await getPool();
    const request = pool.request();

    request.input('ProductId', sql.UniqueIdentifier, productId);
    request.input('AgentId', sql.UniqueIdentifier, agentId);
    request.input('TenantId', sql.UniqueIdentifier, tenantId);
    request.input('AllProductsId', sql.UniqueIdentifier, '00000000-0000-0000-0000-000000000000');
    // Rule effectiveness: only include rules where EffectiveDate <= date and (TerminationDate IS NULL or TerminationDate >= date).
    // Use payment date (PaymentDate or CreatedDate from payment) when false so rules in effect at payment time apply; use current date only when explicitly requested.
    const effectiveDate = useCurrentDateForRuleEffectiveness ? new Date() : (paymentDate || new Date());
    request.input('PaymentDate', sql.DateTime2, effectiveDate);
    
    logger.info('🔍 getApplicableRules - Date filtering', {
      paymentDate,
      useCurrentDateForRuleEffectiveness,
      effectiveDateUsed: effectiveDate,
      isCurrentDate: useCurrentDateForRuleEffectiveness
    }, 'Commission');
    
    // Add HouseholdId and GroupId for split rule filtering
    if (householdId) {
      request.input('HouseholdId', sql.UniqueIdentifier, householdId);
    }
    if (groupId) {
      request.input('GroupId', sql.UniqueIdentifier, groupId);
    }

    // Use enrollment ProductIds if provided (enrollments store component product IDs directly)
    // Otherwise, check if product is a bundle and get included products as fallback
    let productIdsToCheck = enrollmentProductIds || [];
    
    if (productIdsToCheck.length === 0) {
      // Fallback: Check if product is a bundle and get included products
      try {
        const bundleCheckRequest = pool.request();
        bundleCheckRequest.input('ProductId', sql.UniqueIdentifier, productId);
        const bundleCheckResult = await bundleCheckRequest.query(`
          SELECT 
            p.IsBundle,
            pb.IncludedProductId
          FROM oe.Products p
          LEFT JOIN oe.ProductBundles pb ON p.ProductId = pb.BundleProductId
          WHERE p.ProductId = @ProductId
        `);
        
        if (bundleCheckResult.recordset.length > 0 && bundleCheckResult.recordset[0].IsBundle) {
          // Product is a bundle - collect all included product IDs
          productIdsToCheck = bundleCheckResult.recordset
            .filter(row => row.IncludedProductId)
            .map(row => row.IncludedProductId);
          console.log('🔍 Product is a bundle, found included products:', productIdsToCheck);
        }
      } catch (error) {
        console.warn('⚠️ Error checking for bundle products:', error.message);
      }
    } else {
      console.log('🔍 Using enrollment ProductIds:', productIdsToCheck);
    }

    // Get rules that apply to this product/agent/tenant combination
    // Rules are ordered by Priority ASC (lower = higher priority)
    // Strategy:
    // 1. Product-specific rules for this product (or enrollment products/bundle components)
    // 2. Agent's default commission rule (if specified)
    // 3. All-products rules
    // Note: Split rules are included here but applied LAST in distributeCommissions
    console.log('🔍 Getting applicable rules for:', {
      productId,
      agentId,
      tenantId,
      householdId,
      groupId,
      allowUnlockedRules,
      enrollmentProductIds: productIdsToCheck.length > 0 ? productIdsToCheck : 'none'
    });
    
    // Conditionally include Locked filter based on allowUnlockedRules flag
    // For simulation (allowUnlockedRules = true), include both locked and unlocked rules
    // For production (allowUnlockedRules = false), only include locked rules
    const lockedCondition = allowUnlockedRules ? '1=1' : 'cr.Locked = 1';
    
    // Build product filter: include primary product, enrollment products, or all products
    let productFilter = 'cr.ProductId = @ProductId';
    let precedenceInClause = 'NULL';
    if (productIdsToCheck.length > 0) {
      // Create input parameters for enrollment/bundle component products
      const productParams = productIdsToCheck.map((id, idx) => {
        const paramName = `EnrollmentProductId${idx}`;
        request.input(paramName, sql.UniqueIdentifier, id);
        return `@${paramName}`;
      });
      const productIdsStr = productParams.join(', ');
      productFilter = `(cr.ProductId = @ProductId OR cr.ProductId IN (${productIdsStr}))`;
      precedenceInClause = productIdsStr;
    }
    
    // Get agent's agency ID for agency-level rule filtering
    let agentAgencyId = null;
    try {
      const agentRequest = pool.request();
      agentRequest.input('AgentId', sql.UniqueIdentifier, agentId);
      const agentResult = await agentRequest.query(`
        SELECT AgencyId
        FROM oe.Agents
        WHERE AgentId = @AgentId
      `);
      if (agentResult.recordset.length > 0 && agentResult.recordset[0].AgencyId) {
        agentAgencyId = agentResult.recordset[0].AgencyId;
        request.input('AgentAgencyId', sql.UniqueIdentifier, agentAgencyId);
        console.log('🔍 Agent has agency:', agentAgencyId);
      }
    } catch (error) {
      console.warn('⚠️ Error fetching agent agency ID:', error.message);
    }

    // Scope-based filter: no EntityType for Agent/Agency/Tenant. Use agentid and agencyId only.
    // Override still identified by EntityType for behavior (takes $ from pool first).
    // CommissionRules columns are tenantId, agencyId, agentid (lowercase); use bracket-quoted names for case-sensitive DBs.
    let agencyScopeFilter = '';
    if (agentAgencyId) {
      agencyScopeFilter = `OR cr.[agencyId] = @AgentAgencyId`;
    }

    const result = await request.query(`
      WITH AgentDefaultRule AS (
        SELECT CommissionRuleId
        FROM oe.Agents
        WHERE AgentId = @AgentId
      )
      SELECT 
        cr.RuleId,
        cr.RuleName,
        cr.ProductId,
        cr.EntityType,
        cr.EntityId,
        cr.[agencyId],
        cr.[agentid],
        cr.TierLevel,
        cr.CommissionType,
        cr.CommissionRate,
        cr.FlatAmount,
        cr.TieredRates,
        cr.CommissionJson,
        cr.Priority,
        cr.Status,
        cr.EffectiveDate,
        cr.TerminationDate,
        cr.TenantId,
        cr.GroupId,
        cr.Locked,
        CASE 
          WHEN cr.ProductId = @ProductId THEN 1
          WHEN ${productIdsToCheck.length > 0 ? `cr.ProductId IN (${precedenceInClause})` : '0=1'} THEN 1
          WHEN cr.RuleId IN (SELECT CommissionRuleId FROM AgentDefaultRule) THEN 2
          WHEN cr.ProductId = @AllProductsId THEN 3
          ELSE 4
        END AS RulePrecedence
      FROM oe.CommissionRules cr
      WHERE (
        ${productFilter}
        OR cr.RuleId IN (SELECT CommissionRuleId FROM AgentDefaultRule)
        OR cr.ProductId = @AllProductsId
      )
        AND cr.Status != 'Deleted'
        AND ${lockedCondition}
        AND cr.EffectiveDate <= CAST(@PaymentDate AS DATE)
        AND (cr.TerminationDate IS NULL OR cr.TerminationDate >= CAST(@PaymentDate AS DATE))
        AND (cr.[tenantId] IS NULL OR cr.[tenantId] = @TenantId)
        AND (
          -- Overrides: take $ from pool first; still identified by EntityType
          (cr.EntityType = 'Override' AND (cr.[agentid] = @AgentId OR cr.EntityId = @AgentId))
          -- Agent-scoped: rules for this agent (agentid = selling agent)
          OR cr.[agentid] = @AgentId
          -- Agency-scoped: rules for this agent's agency
          ${agencyScopeFilter}
          -- Tenant-level: no agencyId, no agentid
          OR (cr.[agencyId] IS NULL AND cr.[agentid] IS NULL)
          -- Behavioral types (Vendor, Tenant, Split) still by EntityType
          OR cr.EntityType = 'Vendor'
          OR cr.EntityType = 'Tenant'
          OR cr.EntityType = 'Split'
        )
      ORDER BY RulePrecedence ASC, cr.Priority ASC, cr.EffectiveDate DESC
    `);

    // Diagnostic: if 0 rules but we have agentAgencyId, check if backend DB has any rules for this product/agency
    if (result.recordset.length === 0 && agentAgencyId) {
      try {
        const diagRequest = pool.request();
        diagRequest.input('ProductId', sql.UniqueIdentifier, productId);
        diagRequest.input('AgentAgencyId', sql.UniqueIdentifier, agentAgencyId);
        diagRequest.input('TenantId', sql.UniqueIdentifier, tenantId);
        diagRequest.input('PaymentDate', sql.DateTime2, effectiveDate);
        const diagResult = await diagRequest.query(`
          SELECT
            (SELECT COUNT(*) FROM oe.CommissionRules cr2
             WHERE cr2.ProductId = @ProductId AND cr2.[agencyId] = @AgentAgencyId AND cr2.Status != 'Deleted' AND cr2.Locked = 1) AS ByProductAgency,
            (SELECT COUNT(*) FROM oe.CommissionRules cr3
             WHERE cr3.ProductId = @ProductId AND cr3.[agencyId] = @AgentAgencyId AND cr3.Status != 'Deleted' AND cr3.Locked = 1
               AND (cr3.[tenantId] IS NULL OR cr3.[tenantId] = @TenantId)
               AND cr3.EffectiveDate <= CAST(@PaymentDate AS DATE)
               AND (cr3.TerminationDate IS NULL OR cr3.TerminationDate >= CAST(@PaymentDate AS DATE))) AS ByProductAgencyTenantDate
        `);
        const row = diagResult.recordset[0];
        const byProductAgency = row?.ByProductAgency ?? 0;
        const byProductAgencyTenantDate = row?.ByProductAgencyTenantDate ?? 0;
        console.log('🔍 getApplicableRules diagnostic (0 rules):', {
          rulesForProductAgency: byProductAgency,
          rulesForProductAgencyTenantDate: byProductAgencyTenantDate,
          effectiveDateUsed: effectiveDate,
          hint: byProductAgency === 0
            ? 'No rules in DB for this product/agency (verify backend DB_NAME matches expected DB, e.g. allaboard-testing)'
            : byProductAgencyTenantDate === 0
              ? 'Rules exist for product/agency but EffectiveDate/TerminationDate or tenantId filter them out'
              : 'Rules exist for product/agency/tenant/date; scope clause may not be matching (check column names)'
        });
      } catch (diagErr) {
        console.warn('⚠️ getApplicableRules diagnostic failed:', diagErr.message);
      }
    }

    console.log('🔍 getApplicableRules query result:', {
      rulesFound: result.recordset.length,
      productIdsToCheck: productIdsToCheck,
      productFilter,
      lockedCondition,
      rules: result.recordset.map(r => ({
        name: r.RuleName,
        productId: r.ProductId,
        entityType: r.EntityType,
        locked: r.Locked,
        effectiveDate: r.EffectiveDate,
        terminationDate: r.TerminationDate
      }))
    });

    return result.recordset;
  }

  /**
   * Resolve the CommissionGroupId to use for a sale.
   * Order: selling agent -> closest upline with group -> agency.
   * Hard-fails if no group is found.
   */
  async resolveCommissionGroupId(agentId, tenantId) {
    const pool = await getPool();

    // 1) Selling agent group (and agencyId for fallback)
    const agentReq = pool.request();
    agentReq.input('AgentId', sql.UniqueIdentifier, agentId);
    agentReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    const agentResult = await agentReq.query(`
      SELECT TOP 1 AgentId, AgencyId, CommissionGroupId
      FROM oe.Agents
      WHERE AgentId = @AgentId AND TenantId = @TenantId
    `);
    if (agentResult.recordset.length === 0) {
      throw new Error(`Agent not found for tenant: agentId=${agentId}, tenantId=${tenantId}`);
    }

    const agentRow = agentResult.recordset[0];
    if (agentRow.CommissionGroupId) {
      return agentRow.CommissionGroupId.toString();
    }

    // 2) Upline groups (closest first by tier level)
    const uplineReq = pool.request();
    uplineReq.input('AgentId', sql.UniqueIdentifier, agentId);
    uplineReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    const uplineResult = await uplineReq.query(`
      SELECT
        u.AgentId,
        a.CommissionGroupId,
        COALESCE(cl.SortOrder, a.CommissionTierLevel, u.TierLevel) AS TierLevel
      FROM oe.fn_GetAgentUplineForCommission(@AgentId) u
      INNER JOIN oe.Agents a ON u.AgentId = a.AgentId
      LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId AND cl.IsActive = 1
      WHERE a.TenantId = @TenantId
        AND u.AgentId != @AgentId
      ORDER BY COALESCE(cl.SortOrder, a.CommissionTierLevel, u.TierLevel) ASC
    `);
    const uplineWithGroup = uplineResult.recordset.find(r => r.CommissionGroupId);
    if (uplineWithGroup?.CommissionGroupId) {
      return uplineWithGroup.CommissionGroupId.toString();
    }

    // 3) Agency group
    if (agentRow.AgencyId) {
      const agencyReq = pool.request();
      agencyReq.input('AgencyId', sql.UniqueIdentifier, agentRow.AgencyId);
      agencyReq.input('TenantId', sql.UniqueIdentifier, tenantId);
      const agencyResult = await agencyReq.query(`
        SELECT TOP 1 CommissionGroupId
        FROM oe.Agencies
        WHERE AgencyId = @AgencyId AND TenantId = @TenantId
      `);
      if (agencyResult.recordset.length > 0 && agencyResult.recordset[0].CommissionGroupId) {
        return agencyResult.recordset[0].CommissionGroupId.toString();
      }
    }

    throw new Error(`No Commission Group assigned: agentId=${agentId}, tenantId=${tenantId}, agencyId=${agentRow.AgencyId || 'NULL'}`);
  }

  /**
   * Get commission rules for a given Commission Group and product context.
   * Returns product-specific rules for productId/enrollmentProductIds plus all-products rules.
   */
  async getCommissionGroupRules(commissionGroupId, productId, agentId, tenantId, householdId = null, groupId = null, paymentDate = null, allowUnlockedRules = false, enrollmentProductIds = null, useCurrentDateForRuleEffectiveness = false) {
    const pool = await getPool();
    const request = pool.request();

    request.input('CommissionGroupId', sql.UniqueIdentifier, commissionGroupId);
    request.input('ProductId', sql.UniqueIdentifier, productId);
    request.input('AgentId', sql.UniqueIdentifier, agentId);
    request.input('AllProductsId', sql.UniqueIdentifier, '00000000-0000-0000-0000-000000000000');

    const effectiveDate = useCurrentDateForRuleEffectiveness ? new Date() : (paymentDate || new Date());
    request.input('PaymentDate', sql.DateTime2, effectiveDate);

    if (householdId) request.input('HouseholdId', sql.UniqueIdentifier, householdId);
    if (groupId) request.input('GroupId', sql.UniqueIdentifier, groupId);

    const lockedCondition = allowUnlockedRules ? '1=1' : 'cr.Locked = 1';

    const productIdsToCheck = enrollmentProductIds || [];
    let productFilter = 'cr.ProductId = @ProductId';
    let precedenceInClause = 'NULL';
    if (productIdsToCheck.length > 0) {
      const productParams = productIdsToCheck.map((id, idx) => {
        const paramName = `EnrollmentProductId${idx}`;
        request.input(paramName, sql.UniqueIdentifier, id);
        return `@${paramName}`;
      });
      const productIdsStr = productParams.join(', ');
      productFilter = `(cr.ProductId = @ProductId OR cr.ProductId IN (${productIdsStr}))`;
      precedenceInClause = productIdsStr;
    }

    const result = await request.query(`
      SELECT
        cr.RuleId,
        cr.RuleName,
        cr.ProductId,
        cr.EntityType,
        cr.EntityId,
        cr.[agencyId],
        cr.[agentid],
        cr.TierLevel,
        cr.CommissionType,
        cr.CommissionRate,
        cr.FlatAmount,
        cr.TieredRates,
        cr.CommissionJson,
        cr.Priority,
        cr.Status,
        cr.EffectiveDate,
        cr.TerminationDate,
        cr.TenantId,
        cr.GroupId,
        cr.Locked,
        CASE
          WHEN cr.ProductId = @ProductId THEN 1
          WHEN ${productIdsToCheck.length > 0 ? `cr.ProductId IN (${precedenceInClause})` : '0=1'} THEN 1
          WHEN cr.ProductId = @AllProductsId THEN 3
          ELSE 4
        END AS RulePrecedence
      FROM oe.CommissionGroupRules cgr
      INNER JOIN oe.CommissionGroups cg ON cg.CommissionGroupId = cgr.CommissionGroupId
      INNER JOIN oe.CommissionRules cr ON cr.RuleId = cgr.RuleId
      WHERE cgr.CommissionGroupId = @CommissionGroupId
        AND (
          ${productFilter}
          OR cr.ProductId = @AllProductsId
        )
        AND cr.Status != 'Deleted'
        AND ${lockedCondition}
        AND cr.EffectiveDate <= CAST(@PaymentDate AS DATE)
        AND (cr.TerminationDate IS NULL OR cr.TerminationDate >= CAST(@PaymentDate AS DATE))
      ORDER BY RulePrecedence ASC, cr.Priority ASC, cr.EffectiveDate DESC
    `);

    return result.recordset;
  }

  /**
   * Distribute commissions based on rules and agent hierarchy.
   * Scope is determined by agentid/agencyId only (EntityType not used for order).
   * Processing Order:
   * 1. Commission Overrides (EntityType = 'Override') - take $ from pool first; % rules use what's left
   * 2. Agent default rule (oe.Agents.CommissionRuleId) - apply once; do not apply again later
   * 3. Agent-scoped rules (agentid = selling agent), then agency-scoped (agencyId = agent's agency), then tenant-level (no scope)
   * 4. Split rules
   * 5. Excess to Primary Agency (if exists) or Tenant/Product Owner - process LAST
   * 
   * @param {Array} rules - Applicable commission rules
   * @param {string} agentId - Selling agent ID
   * @param {number} totalCommissionAllocation - Total commission pool (rules apply to this amount)
   * @param {number} paymentAmount - Payment amount
   * @param {Object} product - Product details
   * @param {number} vendorCommissionAmount - NetRate from ProductPricing (paid 100% to vendor)
   * @param {number} overrideAmount - OverrideRate amount (paid 100% to tenant/product owner)
   * @returns {Promise<Object>} Distribution breakdown
   */
  async distributeCommissions(rules, agentId, totalCommissionAllocation, paymentAmount, product, vendorCommissionAmount = 0, overrideAmount = 0, householdId = null, groupId = null, overrideAgentRuleId = null, tenantId = null, productTier = null, enrollmentProductIds = null, productCommissionAmounts = null, productEnrollmentCounts = null, productVendorAmounts = null, productOwnerAmounts = null, paymentDate = null) {
    const breakdown = {
      agents: [],
      vendors: [],
      tenants: []
    };

    const asOfDate = paymentDate || new Date();

    // FIRST: Pay vendor 100% of NetRate from ProductPricing
    // For group payments with multiple products, split vendor payouts by product using ProductVendorAmounts
    // This ensures each product's vendor gets paid separately
    if (productVendorAmounts && productVendorAmounts.size > 0) {
      // Group payment: create separate vendor payouts for each product
      const pool = await getPool();
      for (const [productIdStr, vendorData] of productVendorAmounts.entries()) {
        if (vendorData && vendorData.vendorAmount > 0) {
          try {
            // Get product details to find vendor
            const productRequest = pool.request();
            productRequest.input('ProductId', sql.UniqueIdentifier, productIdStr);
            const productResult = await productRequest.query(`
              SELECT ProductId, VendorId, Name
              FROM oe.Products
              WHERE ProductId = @ProductId
            `);
            
            if (productResult.recordset.length > 0) {
              const productData = productResult.recordset[0];
              if (productData.VendorId) {
                breakdown.vendors.push({
                  vendorId: productData.VendorId,
                  amount: vendorData.vendorAmount,
                  ruleId: null,
                  ruleName: 'Vendor Payout (ProductPricing.NetRate)',
                  isVendorCommission: true,
                  productId: productIdStr // Include productId for tracking
                });
                console.log('💰 Vendor commission added (per-product):', {
                  vendorId: productData.VendorId,
                  productId: productIdStr,
                  productName: productData.Name,
                  amount: vendorData.vendorAmount,
                  enrolledHouseholdsCount: vendorData.enrolledHouseholdsCount !== undefined ? vendorData.enrolledHouseholdsCount : 0
                });
              }
            }
          } catch (error) {
            logger.warn('Error getting product vendor for vendor payout', {
              productId: productIdStr,
              error: error.message
            }, 'Commission');
          }
        }
      }
    } else if (vendorCommissionAmount > 0 && product.VendorId) {
      // Single product payment: use main product's vendor
      breakdown.vendors.push({
        vendorId: product.VendorId,
        amount: vendorCommissionAmount,
        ruleId: null,
        ruleName: 'Vendor Payout (ProductPricing.NetRate)',
        isVendorCommission: true
      });
      console.log('💰 Vendor commission added:', {
        vendorId: product.VendorId,
        amount: vendorCommissionAmount
      });
    }

    // SECOND: Pay override to configured destinations in ProductOverrides table
    // Check ProductOverrides table to see if destinations are configured
    // If no destinations exist, create "Unknown" entry as warning
    if (productOwnerAmounts && productOwnerAmounts.size > 0) {
      // Group payment: create separate product owner payouts for each product
      const pool = await getPool();
      for (const [productIdStr, ownerData] of productOwnerAmounts.entries()) {
        // NOTE: override amounts are defined in oe.ProductOverrides.OverrideAmount (not inferred from a pooled overrideAmount).
        // We still only process if caller indicates this product should be checked (presence in productOwnerAmounts).
        if (ownerData) {
          try {
            // Get product details and check for configured overrides
            const productRequest = pool.request();
            productRequest.input('ProductId', sql.UniqueIdentifier, productIdStr);
            const productResult = await productRequest.query(`
              SELECT pr.ProductId, pr.ProductOwnerId, pr.Name as ProductName
              FROM oe.Products pr
              WHERE pr.ProductId = @ProductId
            `);
            
            if (productResult.recordset.length === 0) {
              // Product not found - skip (align with overrides tab; no payout entry).
            } else {
              const productData = productResult.recordset[0];
              const paymentOverrideTotal = Number(ownerData.overrideAmount || 0);

              // Load applicable overrides for this product as of payment date.
              // If productPricingId is provided, prefer exact matches; otherwise fall back to product-level overrides.
              const overrideRequest = pool.request();
              overrideRequest.input('ProductId', sql.UniqueIdentifier, productIdStr);
              overrideRequest.input('AsOfDate', sql.DateTime2, asOfDate);
              const overrideResult = await overrideRequest.query(`
                SELECT po.OverrideId, po.TenantId, po.OverrideACHId, po.ProductPricingId,
                  po.OverrideName, po.OverrideAmount, po.OverrideType,
                  pp.TierType, pp.Label, pp.MinAge, pp.MaxAge, pp.TobaccoStatus,
                  t.Name as TenantName, po.Priority, po.EffectiveDate
                FROM oe.ProductOverrides po
                LEFT JOIN oe.ProductPricing pp ON po.ProductPricingId = pp.ProductPricingId
                LEFT JOIN oe.Tenants t ON po.TenantId = t.TenantId
                WHERE po.ProductId = @ProductId
                  AND po.IsActive = 1
                  AND (po.EffectiveDate IS NULL OR po.EffectiveDate <= @AsOfDate)
                  AND (po.ExpirationDate IS NULL OR po.ExpirationDate > @AsOfDate)
                ORDER BY po.Priority, po.EffectiveDate
              `);
              
              const requestedPricingId = ownerData?.productPricingId || ownerData?.ProductPricingId || null;
              const allRows = overrideResult.recordset || [];
              const exactRows = requestedPricingId
                ? allRows.filter((r) => r.ProductPricingId && r.ProductPricingId.toString() === requestedPricingId.toString())
                : [];
              const fallbackRows = allRows.filter((r) => !r.ProductPricingId);
              const applicableRows = exactRows.length > 0 ? exactRows : fallbackRows;
              const rowsWithAmount = applicableRows.filter((r) => Number(r.OverrideAmount || 0) > 0);

              if (rowsWithAmount.length > 0 && paymentOverrideTotal > 0) {
                // Allocate payment's override total to override rows (by ratio of row.OverrideAmount)
                const sumRowAmount = rowsWithAmount.reduce((s, r) => s + Number(r.OverrideAmount || 0), 0);
                const amounts = sumRowAmount > 0
                  ? rowsWithAmount.map((r) => Math.round((paymentOverrideTotal * Number(r.OverrideAmount || 0) / sumRowAmount) * 100) / 100)
                  : rowsWithAmount.map(() => 0);
                // Fix rounding: give any remainder to first row
                const allocated = amounts.reduce((a, b) => a + b, 0);
                if (allocated < paymentOverrideTotal && amounts.length > 0) {
                  amounts[0] = Math.round((amounts[0] + (paymentOverrideTotal - allocated)) * 100) / 100;
                }
                rowsWithAmount.forEach((row, i) => {
                  const amt = amounts[i] || 0;
                  if (amt <= 0) return;
                  breakdown.tenants.push({
                    tenantId: row.TenantId?.toString() || 'UNKNOWN',
                    tenantName: row.TenantName || 'Unknown Tenant',
                    amount: amt,
                    ruleId: row.OverrideId?.toString() || null,
                    ruleName: row.OverrideName ? `Override - ${row.OverrideName}` : 'Override',
                    isOverride: true,
                    productId: productIdStr,
                    productName: productData.ProductName,
                    overrideId: row.OverrideId?.toString() || null,
                    overrideAchId: row.OverrideACHId ? row.OverrideACHId.toString() : null,
                    productPricingId: row.ProductPricingId ? row.ProductPricingId.toString() : null
                  });
                });
              } else if (paymentOverrideTotal > 0 && productData.ProductOwnerId) {
                // No override rows configured: pay to product owner tenant so amount appears in NACHA
                breakdown.tenants.push({
                  tenantId: productData.ProductOwnerId.toString(),
                  tenantName: productData.ProductName ? `${productData.ProductName} (Owner)` : 'Product Owner',
                  amount: Math.round(paymentOverrideTotal * 100) / 100,
                  ruleId: null,
                  ruleName: 'Override - Product Owner',
                  isOverride: true,
                  productId: productIdStr,
                  productName: productData.ProductName
                });
              }
              // No overrides and no ProductOwnerId: skip (no payout entry).
            }
          } catch (error) {
            console.error('❌ Error processing override destination for product:', {
              productId: productIdStr,
              error: error.message,
              stack: error.stack
            });
            logger.warn('Error processing override destination for product', {
              productId: productIdStr,
              error: error.message,
              stack: error.stack
            }, 'Commission');
            // On error, create Unknown entry to ensure visibility
            breakdown.tenants.push({
              tenantId: 'UNKNOWN',
              amount: Number(ownerData.overrideAmount || 0),
              ruleId: null,
              ruleName: 'Override - Error checking destination',
              isOverride: true,
              productId: productIdStr,
              missingOverrideDestination: true
            });
          }
        }
      }
    } else if (overrideAmount > 0 && product.ProductOwnerId) {
      // Single product payment: check for configured overrides
      try {
        const pool = await getPool();
        const overrideRequest = pool.request();
        overrideRequest.input('ProductId', sql.UniqueIdentifier, product.ProductId);
        overrideRequest.input('AsOfDate', sql.DateTime2, asOfDate);
        const overrideResult = await overrideRequest.query(`
          SELECT po.OverrideId, po.TenantId, po.OverrideACHId, po.ProductPricingId,
            po.OverrideName, po.OverrideAmount, po.OverrideType,
            t.Name as TenantName, po.Priority, po.EffectiveDate
          FROM oe.ProductOverrides po
          LEFT JOIN oe.Tenants t ON po.TenantId = t.TenantId
          WHERE po.ProductId = @ProductId
            AND po.IsActive = 1
            AND (po.EffectiveDate IS NULL OR po.EffectiveDate <= @AsOfDate)
            AND (po.ExpirationDate IS NULL OR po.ExpirationDate > @AsOfDate)
          ORDER BY po.Priority, po.EffectiveDate
        `);

        const rows = overrideResult.recordset || [];
        const rowsWithAmount = rows.filter((r) => Number(r.OverrideAmount || 0) > 0);
        if (rowsWithAmount.length > 0) {
          const sumRowAmount = rowsWithAmount.reduce((s, r) => s + Number(r.OverrideAmount || 0), 0);
          const amounts = sumRowAmount > 0
            ? rowsWithAmount.map((r) => Math.round((overrideAmount * Number(r.OverrideAmount || 0) / sumRowAmount) * 100) / 100)
            : rowsWithAmount.map(() => 0);
          const allocated = amounts.reduce((a, b) => a + b, 0);
          if (allocated < overrideAmount && amounts.length > 0) {
            amounts[0] = Math.round((amounts[0] + (overrideAmount - allocated)) * 100) / 100;
          }
          rowsWithAmount.forEach((row, i) => {
            const amt = amounts[i] || 0;
            if (amt <= 0) return;
            breakdown.tenants.push({
              tenantId: row.TenantId?.toString() || 'UNKNOWN',
              tenantName: row.TenantName || 'Unknown Tenant',
              amount: amt,
              ruleId: row.OverrideId?.toString() || null,
              ruleName: row.OverrideName ? `Override - ${row.OverrideName}` : 'Override',
              isOverride: true,
              productId: product.ProductId,
              productName: product.ProductName,
              overrideId: row.OverrideId?.toString() || null,
              overrideAchId: row.OverrideACHId ? row.OverrideACHId.toString() : null,
              productPricingId: row.ProductPricingId ? row.ProductPricingId.toString() : null
            });
          });
        } else {
          // No override rows: pay to product owner so amount appears in NACHA
          breakdown.tenants.push({
            tenantId: product.ProductOwnerId.toString(),
            tenantName: product.ProductName ? `${product.ProductName} (Owner)` : 'Product Owner',
            amount: Math.round(overrideAmount * 100) / 100,
            ruleId: null,
            ruleName: 'Override - Product Owner',
            isOverride: true,
            productId: product.ProductId,
            productName: product.ProductName
          });
        }
      } catch (error) {
        logger.warn('Error checking override destinations', {
          productId: product.ProductId,
          error: error.message
        }, 'Commission');
        // On error, create Unknown entry
        breakdown.tenants.push({
          tenantId: 'UNKNOWN',
          amount: overrideAmount,
          ruleId: null,
          ruleName: 'Override - Error checking destination',
          isOverride: true,
          productId: product.ProductId,
          missingOverrideDestination: true
        });
      }
    }

    // Start with the full commission allocation
    // Commission overrides will reduce this amount
    let remainingCommission = totalCommissionAllocation;
    let totalCommissionsPaid = 0;

    // Get agent upline hierarchy
    const agentUpline = await this.getAgentUpline(agentId);

    // Commission Groups mode: do not use oe.Agents.CommissionRuleId as an agent default rule.
    const agentDefaultRuleId = null;

    // Commission-group mode: ignore legacy agency/agent scoped columns on rules.
    // Use all mapped group rules (except override/split/vendor) in rule order.
    const overrideRules = rules.filter(rule => rule.EntityType === 'Override');
    const splitRules = rules.filter(rule => rule.EntityType === 'Split');

    // Agent default: the rule assigned to this agent (by RuleId only; do not apply again later)
    const defaultRuleIdStr = agentDefaultRuleId?.toString();
    const agentDefaultRule = defaultRuleIdStr
      ? rules.find(rule => rule.RuleId?.toString() === defaultRuleIdStr)
      : null;

    const groupScopedRules = rules.filter(rule => {
      if (rule.EntityType === 'Override' || rule.EntityType === 'Split' || rule.EntityType === 'Vendor') return false;
      if (defaultRuleIdStr && rule.RuleId?.toString() === defaultRuleIdStr) return false;
      return true;
    });

    console.log('📋 Rule zones (commission-group mode; ignoring rule agency/agent scope fields):', {
      overrideRulesCount: overrideRules.length,
      agentDefaultRule: agentDefaultRule?.RuleName ?? null,
      groupScopedCount: groupScopedRules.length,
      splitRulesCount: splitRules.length
    });

    // ============================================================================
    // STEP 1: PROCESS COMMISSION OVERRIDES FIRST
    // Commission overrides take money from the commission pool and distribute to override agents/agencies
    // The remaining commission after overrides becomes the new allocated commission amount
    // ============================================================================
    if (overrideRules.length > 0) {
      console.log('🎯 Processing Commission Overrides (Step 1):', overrideRules.length, 'override rule(s)');
      
      // Sort override rules by priority (lower = higher priority)
      const sortedOverrideRules = overrideRules.sort((a, b) => (a.Priority || 100) - (b.Priority || 100));
      
      for (const rule of sortedOverrideRules) {
      if (remainingCommission <= 0) {
        break; // No more commission to distribute
      }

      let ruleAmount = 0;

      switch (rule.CommissionType) {
        case 'Percentage':
            // Calculate percentage of ORIGINAL allocated commission, but cap at remaining
            const percentage = rule.CommissionRate || 0;
            const calculatedAmount = totalCommissionAllocation * percentage;
            ruleAmount = Math.min(remainingCommission, calculatedAmount);
            break;

          case 'Flat':
            // Flat amount per payment
            ruleAmount = Math.min(remainingCommission, rule.FlatAmount || 0);
            break;

          case 'Tiered':
            // Complex tiered structure from CommissionJson
            // Calculate from original allocation, but cap at remaining
            // Get enrollment count for this product if available (case-insensitive GUID match)
            const ruleProductIdStr = rule.ProductId ? rule.ProductId.toString().toUpperCase() : null;
            let overrideEnrollmentCount = null;
            if (ruleProductIdStr && productEnrollmentCounts) {
              if (productEnrollmentCounts.has(ruleProductIdStr)) {
                overrideEnrollmentCount = productEnrollmentCounts.get(ruleProductIdStr);
              } else {
                for (const [key, value] of productEnrollmentCounts.entries()) {
                  if (key.toUpperCase() === ruleProductIdStr) {
                    overrideEnrollmentCount = value;
                    break;
                  }
                }
              }
            }
            ruleAmount = await this.calculateComplexTieredCommission(
              rule,
              agentUpline,
              remainingCommission,
              totalCommissionAllocation, // Use original allocation as the pool
              productTier, // Pass product tier for tier-specific amounts
              overrideEnrollmentCount // Pass enrollment count per product for flat rate per enrollment rules
            );
            break;
        }

        // Apply the override rule and reduce remaining commission
        if (ruleAmount > 0) {
          console.log('💰 Processing Override Rule:', {
            ruleName: rule.RuleName,
            ruleAmount,
            remainingCommissionBefore: remainingCommission
          });
          
          const distribution = await this.applyRule(
            rule,
            agentId,
            agentUpline,
            ruleAmount,
            product,
            totalCommissionAllocation, // Pass original allocation for tiered calculations
            productTier // Pass product tier for tier-specific amounts
          );

          // Add override distributions to breakdown
          for (const dist of distribution) {
            // Round amount to nearest cent (standard rounding: 0.5 rounds up)
            const roundedAmount = Math.round(dist.amount * 100) / 100;
            
            if (Math.abs(dist.amount - roundedAmount) > 0.0001) {
              logger.info('💰 Rounding override commission amount', {
                ruleName: rule.RuleName,
                originalAmount: dist.amount,
                roundedAmount: roundedAmount,
                difference: roundedAmount - dist.amount,
                entityId: dist.entityId
              }, 'Commission');
            }
            
            if (dist.entityType === 'Agent') {
              breakdown.agents.push({
                agentId: dist.entityId,
                amount: roundedAmount,
                tierLevel: dist.tierLevel,
                ruleId: rule.RuleId,
                ruleName: rule.RuleName,
                ruleProductId: rule.ProductId,
                commissionType: rule.CommissionType,
                isOverride: true,
                ruleReason: 'Commission Override'
              });
            } else if (dist.entityType === 'Agency') {
              // Agency overrides go to tenants
              breakdown.tenants.push({
                entityType: 'Agency',
                tenantId: dist.entityId,
                amount: roundedAmount,
                tierLevel: dist.tierLevel != null ? dist.tierLevel : null,
                ruleId: rule.RuleId,
                ruleName: rule.RuleName,
                isOverride: true
              });
            }
            
            totalCommissionsPaid += roundedAmount;
            remainingCommission = Math.ceil((remainingCommission - roundedAmount) * 100) / 100;
          }
        }
      }
      
      console.log('✅ Commission Overrides processed. Remaining commission pool:', remainingCommission);
    }

    // ============================================================================
    // STEP 2: PROCESS AGENT DEFAULT RULE (oe.Agents.CommissionRuleId) — apply once; do not apply again later
    // ============================================================================
    if (agentDefaultRule && remainingCommission > 0) {
      console.log('🎯 Processing Agent Default Rule (Step 2):', agentDefaultRule.RuleName);
      
      let ruleAmount = 0;

      switch (agentDefaultRule.CommissionType) {
        case 'Percentage':
          // Calculate percentage of ORIGINAL allocated commission, but cap at remaining
          const percentage = agentDefaultRule.CommissionRate || 0;
          const calculatedAmount = totalCommissionAllocation * percentage;
          ruleAmount = Math.min(remainingCommission, calculatedAmount);
          break;

        case 'Flat':
          ruleAmount = Math.min(remainingCommission, agentDefaultRule.FlatAmount || 0);
          break;

        case 'Tiered':
          // Calculate from original allocation, but cap at remaining
          console.log('🔍 Calculating tiered commission for agent default rule:', {
            ruleName: agentDefaultRule.RuleName,
            ruleId: agentDefaultRule.RuleId,
            productTier,
            agentUplineLength: agentUpline?.length,
            remainingCommission,
            totalCommissionAllocation
          });
          // Get enrollment count for this product if available (case-insensitive GUID match)
          const agentProductIdStr = agentDefaultRule.ProductId ? agentDefaultRule.ProductId.toString().toUpperCase() : null;
          let agentEnrollmentCount = null;
          if (agentProductIdStr && productEnrollmentCounts) {
            if (productEnrollmentCounts.has(agentProductIdStr)) {
              agentEnrollmentCount = productEnrollmentCounts.get(agentProductIdStr);
            } else {
              for (const [key, value] of productEnrollmentCounts.entries()) {
                if (key.toUpperCase() === agentProductIdStr) {
                  agentEnrollmentCount = value;
                  break;
                }
              }
            }
          }
          ruleAmount = await this.calculateComplexTieredCommission(
            agentDefaultRule,
            agentUpline,
            remainingCommission,
            totalCommissionAllocation, // Use original allocation as the pool
            productTier, // Pass product tier for tier-specific amounts
            agentEnrollmentCount // Pass enrollment count per product for flat rate per enrollment rules
          );
          console.log('💰 Tiered commission calculated:', {
            ruleName: agentDefaultRule.RuleName,
            ruleAmount,
            productTier
          });
          break;
      }

      if (ruleAmount > 0) {
        // For agent default rule, determine which commission pool to use
        // If it's product-specific and we have commission amounts per product, use that
        const agentRuleIsProductSpecific = agentDefaultRule.ProductId && 
                                            agentDefaultRule.ProductId !== '00000000-0000-0000-0000-000000000000' &&
                                            productCommissionAmounts &&
                                            productCommissionAmounts.has(agentDefaultRule.ProductId.toString());
        const agentRuleCommissionPool = agentRuleIsProductSpecific 
          ? (productCommissionAmounts.get(agentDefaultRule.ProductId.toString()) || totalCommissionAllocation)
          : totalCommissionAllocation;
        
        const distribution = await this.applyRule(
          agentDefaultRule,
          agentId,
          agentUpline,
          ruleAmount,
          product,
          agentRuleCommissionPool, // Pass appropriate pool (product-specific or total) for tiered calculations
          productTier // Pass product tier for tier-specific amounts
        );

        // Add to breakdown
        for (const dist of distribution) {
          // Round amount to nearest cent (standard rounding: 0.5 rounds up)
          const roundedAmount = Math.round(dist.amount * 100) / 100;
          
          if (Math.abs(dist.amount - roundedAmount) > 0.0001) {
            logger.info('💰 Rounding agent default commission amount', {
              ruleName: agentDefaultRule.RuleName,
              originalAmount: dist.amount,
              roundedAmount: roundedAmount,
              difference: roundedAmount - dist.amount,
              agentId: dist.entityId
            }, 'Commission');
          }
          
          if (dist.entityType === 'Agent') {
            breakdown.agents.push({
              agentId: dist.entityId,
              amount: roundedAmount,
              tierLevel: dist.tierLevel,
              ruleId: agentDefaultRule.RuleId,
              ruleName: agentDefaultRule.RuleName,
              ruleProductId: agentDefaultRule.ProductId,
              commissionType: agentDefaultRule.CommissionType,
              isAgentSpecific: true,
              ruleReason: "Agent's Default Rule (oe.Agents.CommissionRuleId)"
            });
          } else if (dist.entityType === 'Agency') {
            breakdown.tenants.push({
              entityType: 'Agency',
              tenantId: dist.entityId,
              amount: roundedAmount,
              tierLevel: dist.tierLevel,
              ruleId: agentDefaultRule.RuleId,
              ruleName: agentDefaultRule.RuleName,
              isPrimaryAgency: false,
              isOverride: false
            });
          }

          totalCommissionsPaid += roundedAmount;
          remainingCommission = Math.round((remainingCommission - roundedAmount) * 100) / 100;
        }
      }
    }

    // ============================================================================
    // STEP 3: PROCESS GROUP-SCOPED RULES
    // In commission-group mode, legacy rule agency/agent scope fields are ignored.
    // Apply all mapped non-override rules in precedence/priority order.
    // ============================================================================
    const byRuleOrder = (a, b) =>
      ((a.RulePrecedence || 99) - (b.RulePrecedence || 99)) ||
      ((a.Priority || 100) - (b.Priority || 100)) ||
      (new Date(b.EffectiveDate).getTime() - new Date(a.EffectiveDate).getTime());
    const orderedScopeRules = [...groupScopedRules].sort(byRuleOrder);

    for (const rule of orderedScopeRules) {
      if (remainingCommission <= 0) {
        break; // No more commission to distribute
      }

      // Determine which commission amount to use for this rule
      // If rule is product-specific and we have commission amounts per product, use that product's amount
      // Otherwise, use total commission allocation
      const isProductSpecific = rule.ProductId && 
                                 rule.ProductId !== '00000000-0000-0000-0000-000000000000' &&
                                 productCommissionAmounts &&
                                 productCommissionAmounts.has(rule.ProductId.toString());
      
      const ruleCommissionPool = isProductSpecific 
        ? (productCommissionAmounts.get(rule.ProductId.toString()) || 0)
        : totalCommissionAllocation;
      
      // For product-specific rules, we need to track remaining commission per product
      // For now, we'll use a simplified approach: cap rule amount by product's commission amount
      const maxRuleAmount = isProductSpecific 
        ? Math.min(remainingCommission, ruleCommissionPool)
        : remainingCommission;

      let ruleAmount = 0;

      // Handle Tier rules with CommissionJson (even if CommissionType isn't 'Tiered')
      // Check if this is a tier rule with CommissionJson that needs complex tiered calculation
      // A rule is complex tiered if it has CommissionJson with a 'tiers' array, regardless of CommissionType
      let commissionConfig = null;
      if (rule.CommissionJson) {
        try {
          commissionConfig = typeof rule.CommissionJson === 'string' 
            ? JSON.parse(rule.CommissionJson) 
            : rule.CommissionJson;
        } catch (e) {
          // Invalid JSON, skip
        }
      }
      
      const hasTiersStructure = commissionConfig && Array.isArray(commissionConfig.tiers);
      const isTierRuleWithJson = (rule.EntityType === 'Tier' || hasTiersStructure) && rule.CommissionJson && hasTiersStructure;
      
      if (isTierRuleWithJson) {
        // Complex tiered structure from CommissionJson
        // Calculate from appropriate pool, but cap at remaining and product max
        // Get enrollment count for this product if available
        // Try both uppercase and lowercase GUID formats for matching
        const ruleProductIdStr = rule.ProductId ? rule.ProductId.toString().toUpperCase() : null;
        let tierEnrollmentCount = null;
        if (ruleProductIdStr && productEnrollmentCounts) {
          // Try exact match first
          if (productEnrollmentCounts.has(ruleProductIdStr)) {
            tierEnrollmentCount = productEnrollmentCounts.get(ruleProductIdStr);
          } else {
            // Try case-insensitive match by iterating
            for (const [key, value] of productEnrollmentCounts.entries()) {
              if (key.toUpperCase() === ruleProductIdStr) {
                tierEnrollmentCount = value;
                break;
              }
            }
          }
        }
        console.log('🔍 Before calling calculateComplexTieredCommission:', {
          ruleName: rule.RuleName,
          maxRuleAmount,
          ruleCommissionPool,
          availableCommission: maxRuleAmount,
          productTier,
          hasTiersStructure,
          isTierRuleWithJson,
          enrollmentCount: tierEnrollmentCount,
          ruleProductId: rule.ProductId?.toString()
        });
        // Check for tier distribution in productEnrollmentCounts
        let tierDistribution = null;
        if (ruleProductIdStr && productEnrollmentCounts) {
          const tierDistKey = `TIER_DIST:${ruleProductIdStr}`;
          if (productEnrollmentCounts.has(tierDistKey)) {
            tierDistribution = productEnrollmentCounts.get(tierDistKey);
          }
        }
        
        ruleAmount = await this.calculateComplexTieredCommission(
          rule,
          agentUpline,
          maxRuleAmount,
          ruleCommissionPool, // Use product-specific or total pool
          productTier, // Pass product tier for tier-specific amounts
          tierEnrollmentCount, // Pass enrollment count per product for flat rate per enrollment rules
          productEnrollmentCounts, // Pass productEnrollmentCounts to access tier distribution
          rule.ProductId // Pass rule product ID to look up tier distribution
        );
        console.log('💰 Tier rule (EntityType=Tier) amount calculated:', {
          ruleName: rule.RuleName,
          ruleAmount,
          maxRuleAmount,
          ruleCommissionPool,
          entityType: rule.EntityType,
          commissionType: rule.CommissionType,
          returnedFromCalculateComplexTieredCommission: ruleAmount
        });
      } else {
        switch (rule.CommissionType) {
          case 'Percentage':
          // Calculate percentage of appropriate commission pool (product-specific or total)
          const percentage = rule.CommissionRate || 0;
          console.log('📊 Processing Percentage rule:', {
            ruleName: rule.RuleName,
            percentage,
            isProductSpecific,
            ruleCommissionPool,
            totalCommissionAllocation,
            remainingCommission,
            maxRuleAmount,
            entityType: rule.EntityType,
            productId: rule.ProductId
          });
          
          if (rule.EntityType === 'Tier' && rule.TierLevel !== null) {
            // Tier-based percentage rule - calculate from appropriate pool
            ruleAmount = await this.calculateTieredCommission(
              rule,
              agentUpline,
              maxRuleAmount,
              ruleCommissionPool // Use product-specific or total pool
            );
          } else {
            // Standard percentage rule
            // Calculate from appropriate commission pool, but cap at remaining and product max
            const calculatedAmount = ruleCommissionPool * percentage;
            ruleAmount = Math.min(maxRuleAmount, calculatedAmount);
            console.log('💰 Calculated rule amount:', ruleAmount, '(calculated:', calculatedAmount, 'from pool:', ruleCommissionPool, ', max:', maxRuleAmount, ', remaining:', remainingCommission, ')');
          }
          break;

        case 'Flat':
          // Flat amount per payment - cap at remaining and product max
          ruleAmount = Math.min(maxRuleAmount, rule.FlatAmount || 0);
          break;

        case 'Tiered':
          // Complex tiered structure from CommissionJson
            // Calculate from appropriate pool, but cap at remaining and product max
            // Get enrollment count for this product if available (case-insensitive GUID match)
            const tieredProductIdStr = rule.ProductId ? rule.ProductId.toString().toUpperCase() : null;
            let tieredEnrollmentCount = null;
            if (tieredProductIdStr && productEnrollmentCounts) {
              if (productEnrollmentCounts.has(tieredProductIdStr)) {
                tieredEnrollmentCount = productEnrollmentCounts.get(tieredProductIdStr);
              } else {
                for (const [key, value] of productEnrollmentCounts.entries()) {
                  if (key.toUpperCase() === tieredProductIdStr) {
                    tieredEnrollmentCount = value;
                    break;
                  }
                }
              }
            }
          ruleAmount = await this.calculateComplexTieredCommission(
            rule,
            agentUpline,
              maxRuleAmount,
              ruleCommissionPool, // Use product-specific or total pool
              productTier, // Pass product tier for tier-specific amounts
              tieredEnrollmentCount // Pass enrollment count per product for flat rate per enrollment rules
            );
            console.log('💰 Tiered rule amount calculated:', {
              ruleName: rule.RuleName,
              ruleAmount,
              maxRuleAmount,
              ruleCommissionPool,
              commissionType: rule.CommissionType
            });
          break;
        }
      }

      // Apply the rule and update breakdown
      console.log('🔍 Rule amount check:', {
        ruleName: rule.RuleName,
        ruleAmount,
        entityType: rule.EntityType,
        commissionType: rule.CommissionType,
        willApply: ruleAmount > 0
      });
      
      if (ruleAmount > 0) {
        console.log('🎯 Applying rule:', {
          ruleName: rule.RuleName,
          ruleAmount,
          entityType: rule.EntityType,
          agentId
        });
        
        const distribution = await this.applyRule(
          rule,
          agentId,
          agentUpline,
          ruleAmount,
          product,
          ruleCommissionPool, // Pass appropriate pool (product-specific or total) for tiered calculations
          productTier // Pass product tier for tier-specific amounts
        );

        console.log('📦 Distribution result:', {
          ruleName: rule.RuleName,
          distributionCount: distribution.length,
          distribution: distribution
        });

        // Add to breakdown
        for (const dist of distribution) {
          // Round amount to nearest cent (standard rounding: 0.5 rounds up)
          // e.g., 10.055 becomes 10.06, 10.054 becomes 10.05
          const roundedAmount = Math.round(dist.amount * 100) / 100;
          
          if (Math.abs(dist.amount - roundedAmount) > 0.0001) {
            logger.info('💰 Rounding commission amount', {
              ruleName: rule.RuleName,
              originalAmount: dist.amount,
              roundedAmount: roundedAmount,
              difference: roundedAmount - dist.amount,
              entityType: dist.entityType,
              entityId: dist.entityId
            }, 'Commission');
          }
          
          if (dist.entityType === 'Agent') {
            breakdown.agents.push({
              agentId: dist.entityId,
              amount: roundedAmount,
              tierLevel: dist.tierLevel,
              ruleId: rule.RuleId,
              ruleName: rule.RuleName,
              commissionType: rule.CommissionType,
              ruleProductId: rule.ProductId,
              priority: rule.Priority,
              ruleReason: rule.Priority != null ? `Priority ${rule.Priority}` : 'Regular Rule'
            });
          } else if (dist.entityType === 'Agency') {
            // Tier-slot agency payout: same array (`breakdown.tenants[]`) as
            // primary-agency overflow + Override-Agency, distinguished by
            // entityType: 'Agency'. tenantId carries the AgencyId by convention.
            breakdown.tenants.push({
              entityType: 'Agency',
              tenantId: dist.entityId,
              amount: roundedAmount,
              tierLevel: dist.tierLevel,
              ruleId: rule.RuleId,
              ruleName: rule.RuleName,
              isPrimaryAgency: false,
              isOverride: false
            });
          } else if (dist.entityType === 'Vendor') {
            breakdown.vendors.push({
              vendorId: dist.entityId,
              amount: roundedAmount,
              ruleId: rule.RuleId,
              ruleName: rule.RuleName
            });
          } else if (dist.entityType === 'Tenant') {
            breakdown.tenants.push({
              entityType: 'Tenant',
              tenantId: dist.entityId,
              amount: roundedAmount,
              ruleId: rule.RuleId,
              ruleName: rule.RuleName
            });
          }

          totalCommissionsPaid += roundedAmount;
          remainingCommission = Math.round((remainingCommission - roundedAmount) * 100) / 100;
        }
      }
    }

    // ============================================================================
    // STEP 6: APPLY SPLIT RULES (after agent default and scope rules)
    // Split rules take from the primary agent's total and give to split partners
    // Split rules are HouseholdId or GroupId specific
    // ============================================================================
    if (splitRules.length > 0) {
      console.log('🎯 Processing Split Rules (Step 4):', splitRules.length, 'split rule(s)');
      console.log('🔍 Available split rules:', splitRules.map(r => ({
        ruleId: r.RuleId?.toString(),
        ruleName: r.RuleName,
        groupId: r.GroupId?.toString()
      })));
      console.log('🔍 Current breakdown.agents:', breakdown.agents.map(a => ({
        agentId: a.agentId,
        amount: a.amount,
        ruleId: a.ruleId
      })));
      
      // Filter split rules by GroupId
      // Note: CommissionRules currently only has GroupId (HouseholdId will be added soon)
      // Split rules are GroupId-specific: if a rule has a GroupId, it only applies to payments for that group
      // If a rule has no GroupId, it applies globally (to all groups/households)
      // TODO: When HouseholdId is added, update filtering to check both GroupId and HouseholdId
      const applicableSplitRules = splitRules.filter(rule => {
        // If rule has a GroupId, it must match the payment's GroupId
        if (rule.GroupId) {
          const matches = groupId && rule.GroupId === groupId;
          console.log(`🔍 Split rule ${rule.RuleName} GroupId check:`, {
            ruleGroupId: rule.GroupId?.toString(),
            paymentGroupId: groupId,
            matches
          });
          return matches;
        }
        // If rule has no GroupId, it applies globally (to all payments)
        console.log(`🔍 Split rule ${rule.RuleName} has no GroupId - applies globally`);
        return true;
      });
      
      console.log('🔍 Applicable split rules:', applicableSplitRules.length, applicableSplitRules.map(r => r.RuleName));

      for (const splitRule of applicableSplitRules) {
        console.log('🔍 Processing split rule:', splitRule.RuleName, splitRule.RuleId?.toString());
        if (!splitRule.CommissionJson) {
          console.log('⚠️ Split rule has no CommissionJson:', splitRule.RuleName);
          continue;
        }

        try {
          const commissionConfig = typeof splitRule.CommissionJson === 'string'
            ? JSON.parse(splitRule.CommissionJson)
            : splitRule.CommissionJson;

          console.log('🔍 Split rule CommissionJson parsed:', {
            ruleName: splitRule.RuleName,
            hasSplitCommission: !!commissionConfig.splitCommission,
            splitCommission: commissionConfig.splitCommission
          });

          if (!commissionConfig.splitCommission) {
            console.log('⚠️ Split rule has no splitCommission config:', splitRule.RuleName);
            continue;
          }

          const splitConfig = commissionConfig.splitCommission;
          const primaryAgentId = splitConfig.primaryAgentId;

          console.log('🔍 Split rule config:', {
            ruleName: splitRule.RuleName,
            primaryAgentId,
            splitAgents: splitConfig.agents?.length || 0
          });

          if (!primaryAgentId) {
            console.log('⚠️ Split rule has no primaryAgentId:', splitRule.RuleName);
            continue;
          }

          // Find the primary agent's current total commission
          // The primaryAgentId in the split rule must match an agent in the distribution
          const primaryAgentPayout = breakdown.agents.find(a => a.agentId === primaryAgentId);
          
          console.log('🔍 Split rule processing - looking for primary agent:', {
            splitRuleId: splitRule.RuleId,
            splitRuleName: splitRule.RuleName,
            primaryAgentId,
            foundPrimaryAgent: !!primaryAgentPayout,
            primaryAgentAmount: primaryAgentPayout?.amount || 0,
            allAgents: breakdown.agents.map(a => ({ agentId: a.agentId, amount: a.amount, ruleId: a.ruleId }))
          });
          
          if (!primaryAgentPayout || primaryAgentPayout.amount <= 0) {
            // Primary agent has no commission, skip this split rule
            // This can happen if the primary agent didn't receive any commission from regular rules
            console.log('⚠️ Split rule skipped - primary agent has no commission', {
              splitRuleId: splitRule.RuleId,
              splitRuleName: splitRule.RuleName,
              primaryAgentId,
              householdId,
              groupId,
              primaryAgentPayout: primaryAgentPayout ? { agentId: primaryAgentPayout.agentId, amount: primaryAgentPayout.amount } : null
            });
            logger.info('Split rule skipped - primary agent has no commission', {
              splitRuleId: splitRule.RuleId,
              primaryAgentId,
              householdId,
              groupId
            }, 'Commission');
            continue;
          }

          const primaryAgentTotal = primaryAgentPayout.amount;

          // Process each split partner
          if (splitConfig.agents && Array.isArray(splitConfig.agents)) {
            for (const splitAgent of splitConfig.agents) {
              // Skip the primary agent (they're already in the list)
              if (splitAgent.agentId === primaryAgentId) {
                continue;
              }

              const splitPercentage = splitAgent.percentage || 0;
              if (splitPercentage <= 0) continue;

              // Calculate split amount (percentage of primary agent's total)
              const splitAmount = primaryAgentTotal * splitPercentage;

              // Reduce primary agent's commission
              primaryAgentPayout.amount -= splitAmount;
              primaryAgentPayout.splitAmount = splitAmount; // Track how much was split
              primaryAgentPayout.splitRuleId = splitRule.RuleId;
              primaryAgentPayout.splitPartnerId = splitAgent.agentId;
              primaryAgentPayout.splitPercentage = splitPercentage; // Store percentage from rule
              primaryAgentPayout.isPrimaryInSplit = true;
              // Add ruleReason if not already set (in case this is the first split affecting this agent)
              if (!primaryAgentPayout.ruleReason) {
                primaryAgentPayout.ruleReason = primaryAgentPayout.isAgentSpecific 
                  ? "Agent's Assigned Rule (Split Applied)"
                  : primaryAgentPayout.priority != null 
                    ? `Priority ${primaryAgentPayout.priority} (Split Applied)`
                    : 'Regular Rule (Split Applied)';
              }

              // Add or update split partner's commission
              let splitPartnerPayout = breakdown.agents.find(a => a.agentId === splitAgent.agentId);
              
              if (splitPartnerPayout) {
                // Partner already has commission from other rules, add to it
                splitPartnerPayout.amount += splitAmount;
                splitPartnerPayout.splitAmount = splitAmount;
                splitPartnerPayout.splitRuleId = splitRule.RuleId;
                splitPartnerPayout.isSplitPartner = true;
                splitPartnerPayout.splitFromAgentId = primaryAgentId;
                splitPartnerPayout.splitPercentage = splitPercentage; // Store percentage from rule
                splitPartnerPayout.isPrimaryInSplit = false;
              } else {
                // Partner has no other commission, create new entry
                breakdown.agents.push({
                  agentId: splitAgent.agentId,
                  amount: splitAmount,
                  tierLevel: 0,
                  ruleId: splitRule.RuleId,
                  ruleName: splitRule.RuleName,
                  commissionType: splitRule.CommissionType,
                  splitAmount: splitAmount,
                  isSplitPartner: true,
                  splitFromAgentId: primaryAgentId,
                  splitPercentage: splitPercentage, // Store percentage from rule
                  isPrimaryInSplit: false,
                  ruleReason: 'Split Rule'
                });
              }

              logger.info('Split commission applied', {
                primaryAgentId,
                splitPartnerId: splitAgent.agentId,
                splitPercentage,
                splitAmount,
                primaryAgentRemaining: primaryAgentPayout.amount,
                ruleId: splitRule.RuleId
              }, 'Commission');
            }
          }
        } catch (error) {
          logger.error('Error applying split commission rule', {
            error: error.message,
            ruleId: splitRule.RuleId
          }, 'Commission');
        }
      }
    }
    
    // Calculate all payouts for validation (after split rules, before excess calculation)
    const vendorAmountPaid = breakdown.vendors.reduce((sum, v) => sum + (v.isVendorCommission ? v.amount : 0), 0);
    const overrideAmountPaid = breakdown.tenants.reduce((sum, t) => sum + (t.isOverride ? t.amount : 0), 0);
    const totalAgentPayments = breakdown.agents.reduce((sum, a) => sum + a.amount, 0);
    // Recalculate totalCommissionsPaid after split rules (split rules redistribute, don't add new commission)
    // Since individual amounts are already rounded UP, we should NOT round the total again
    // Just sum the already-rounded amounts to avoid double-rounding
    const totalCommissionsPaidAfterSplit = breakdown.agents.reduce((sum, a) => sum + a.amount, 0) + 
      breakdown.vendors.reduce((sum, v) => sum + (v.isVendorCommission ? 0 : v.amount), 0) +
      breakdown.tenants.reduce((sum, t) => sum + (t.isOverride ? 0 : t.amount), 0);
    
    logger.info('💰 Total commissions paid calculation', {
      totalCommissionsPaidAfterSplit: totalCommissionsPaidAfterSplit,
      agentCount: breakdown.agents.length,
      vendorCount: breakdown.vendors.length,
      tenantCount: breakdown.tenants.length,
      agentTotal: breakdown.agents.reduce((sum, a) => sum + a.amount, 0),
      vendorTotal: breakdown.vendors.reduce((sum, v) => sum + (v.isVendorCommission ? 0 : v.amount), 0),
      tenantTotal: breakdown.tenants.reduce((sum, t) => sum + (t.isOverride ? 0 : t.amount), 0)
    }, 'Commission');
    const totalPayoutsBeforeExcess = vendorAmountPaid + overrideAmountPaid + totalCommissionsPaidAfterSplit;
    
    // ============================================================================
    // STEP 7: EXCESS GOES TO PRIMARY AGENCY
    // Overflow = remaining commission pool that wasn't allocated by any rules
    // Overflow ONLY goes to Primary Agency (no fallback to Product Owner)
    // ============================================================================
    // Overflow is ONLY what's left from the commission pool after rules have been applied
    // Round remaining commission to avoid floating point issues (standard rounding)
    const totalExcess = Math.round(remainingCommission * 100) / 100;
    
    if (Math.abs(remainingCommission - totalExcess) > 0.0001) {
      logger.info('💰 Rounding overflow (unallocated commission)', {
        originalRemaining: remainingCommission,
        roundedOverflow: totalExcess,
        difference: totalExcess - remainingCommission
      }, 'Commission');
    }
    
    // VALIDATION: Ensure total payouts (before excess) don't exceed available pools
    // Compare against (vendorCommissionAmount + overrideAmount + totalCommissionAllocation) instead of paymentAmount
    // because paymentAmount excludes fees, but the pools (NetRate + OverrideRate + Commission) are the actual available amounts
    // Skip validation for simulations (paymentAmount = 0 indicates simulation)
    // Allow 2-cent tolerance for floating-point rounding (e.g. 430.00 vs 429.99)
    const totalAvailablePools = vendorCommissionAmount + overrideAmount + totalCommissionAllocation;
    const roundingTolerance = 0.02;
    if (paymentAmount > 0 && (totalPayoutsBeforeExcess - totalAvailablePools) > roundingTolerance) {
      logger.error('Total payouts exceed available pools', {
        paymentAmount,
        totalAvailablePools,
        vendorCommissionAmount,
        overrideAmount,
        totalCommissionAllocation,
        vendorAmountPaid,
        overrideAmountPaid,
        totalCommissionsPaidAfterSplit,
        totalAgentPayments,
        totalPayoutsBeforeExcess,
        difference: totalPayoutsBeforeExcess - totalAvailablePools
      }, 'Commission');
      throw new Error(
        `Total payouts ($${totalPayoutsBeforeExcess.toFixed(2)}) exceed available pools ($${totalAvailablePools.toFixed(2)}) ` +
        `by $${(totalPayoutsBeforeExcess - totalAvailablePools).toFixed(2)}. This indicates an error in commission calculation.`
      );
    }
    
    // Collect all rule IDs that were evaluated (even if they resulted in $0 or overflow)
    // This helps with audit trail - we want to know which rules were considered
    const evaluatedRuleIds = [];
    if (agentDefaultRule) {
      evaluatedRuleIds.push(agentDefaultRule.RuleId);
    }
    for (const rule of orderedScopeRules) {
      if (rule.RuleId && !evaluatedRuleIds.includes(rule.RuleId)) {
        evaluatedRuleIds.push(rule.RuleId);
      }
    }
    
    // Excess distribution: goes to primary agency (if exists) or product owner (tenant)
    // Priority: 1) Primary Agency, 2) Tenant/Product Owner
    // Note: VendorCommission is already handled separately and paid 100% to vendor
    if (totalExcess > 0) {
      let excessRecipientId = null;
      let excessRecipientType = null;
      let excessRecipientName = 'Excess';
      let primaryAgency = null; // Declare outside if block so it's accessible later
      
      // Step 1: Check for primary agency (overflow goes to Primary Agency, not Product Owner)
      // Overflow goes to the selling agent's primary agency (tenantId from function call)
      // Product owner's tenant is irrelevant - overflow always goes to agent's primary agency
      const tenantIdForAgency = tenantId;
      if (tenantIdForAgency) {
        const pool = await getPool();
        const primaryAgencyRequest = pool.request();
        primaryAgencyRequest.input('TenantId', sql.UniqueIdentifier, tenantIdForAgency);
        
        const primaryAgencyResult = await primaryAgencyRequest.query(`
          SELECT
            a.AgencyId,
            a.AgencyName,
            a.IsPrimary,
            COALESCE(cl.SortOrder, a.CommissionTierLevel) AS CommissionTierLevel,
            a.CommissionLevelId,
            cl.DisplayName AS CommissionLevelName
          FROM oe.Agencies a
          LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId AND cl.IsActive = 1
          WHERE a.TenantId = @TenantId 
            AND a.IsPrimary = 1
            AND a.Status = 'Active'
        `);
        
        if (primaryAgencyResult.recordset.length > 0) {
          primaryAgency = primaryAgencyResult.recordset[0];
          excessRecipientId = primaryAgency.AgencyId.toString();
          excessRecipientType = 'Agency';
          excessRecipientName = `Primary Agency Excess (${primaryAgency.AgencyName})`;
          
          logger.info('💰 Excess going to primary agency', {
            agencyId: excessRecipientId,
            agencyName: primaryAgency.AgencyName,
            agencyTierLevel: primaryAgency.CommissionTierLevel,
            amount: totalExcess,
            tenantId: tenantIdForAgency
          }, 'Commission');
        }
      }
      
      // Note: No fallback to Product Owner - overflow ONLY goes to Primary Agency
      // If no Primary Agency exists, overflow is not allocated (this should be rare)
      if (!excessRecipientId) {
        logger.warn('💰 No primary agency found for excess - excess will not be allocated', {
          tenantId: tenantIdForAgency,
          productOwnerId: product.ProductOwnerId,
          amount: totalExcess
        }, 'Commission');
        if (totalExcess > 0) {
          // Surface to UI: simulator banner + NACHA preview consumers key on this.
          breakdown.overflowDestinationMissing = true;
        }
      }
      
      // Add excess to breakdown
      if (excessRecipientId) {
        if (excessRecipientType === 'Agency' && primaryAgency) {
          // Check if agency's tier level matches any tiered rule
          const agencyTierLevel = primaryAgency.CommissionTierLevel ?? null;
          let matchedTieredRule = null;
          let matchedTierCommission = 0;
          
          if (agencyTierLevel !== null) {
            // Check all tiered rules (agent default and scope rules) for matching tier level
            const allTieredRules = [
              ...(agentDefaultRule && agentDefaultRule.CommissionJson ? [agentDefaultRule] : []),
              ...orderedScopeRules.filter(r => r.CommissionJson && (r.EntityType === 'Tier' || r.CommissionType === 'Tiered'))
            ];
            
            for (const rule of allTieredRules) {
              try {
                const commissionConfig = typeof rule.CommissionJson === 'string'
                  ? JSON.parse(rule.CommissionJson)
                  : rule.CommissionJson;
                
                if (commissionConfig.tiers && Array.isArray(commissionConfig.tiers)) {
                  // Find tier matching agency's tier level
                  const matchingTier = commissionConfig.tiers.find(t => 
                    (t.tierLevel || t.level || 0) === agencyTierLevel
                  );
                  
                  if (matchingTier) {
                    matchedTieredRule = rule;
                    // Calculate tier commission amount (simplified - actual would need productTier and enrollmentCount)
                    const commissionType = commissionConfig.type || 'percentage';
                    if (commissionType === 'flatrate' && matchingTier.flatAmount !== undefined) {
                      matchedTierCommission = matchingTier.flatAmount;
                    } else if (commissionType === 'percentage' && matchingTier.rate !== undefined) {
                      const rate = matchingTier.rate > 1 ? matchingTier.rate / 100 : matchingTier.rate;
                      matchedTierCommission = totalCommissionAllocation * rate;
                    }
                    break;
                  }
                }
              } catch (error) {
                // Skip rules with invalid JSON
              }
            }
          }
          
          // If agency's tier level matches a tiered rule, show that rule name instead of "Overflow"
          if (matchedTieredRule && matchedTierCommission > 0) {
            breakdown.tenants.push({
              entityType: 'Agency',
              tenantId: excessRecipientId, // Actually AgencyId
              amount: totalExcess, // Use actual excess amount
              ruleId: matchedTieredRule.RuleId, // Include rule ID for tiered commissions
              evaluatedRuleIds: evaluatedRuleIds.length > 0 ? evaluatedRuleIds : null,
              ruleName: matchedTieredRule.RuleName || excessRecipientName,
              isOverflow: true, // Still technically overflow, but from a tiered rule
              isExcess: true,
              isPrimaryAgency: true,
              tierLevel: agencyTierLevel // Include agency's tier level
            });
            
            logger.info('💰 Agency tier matches tiered rule', {
              agencyId: excessRecipientId,
              agencyName: primaryAgency.AgencyName,
              agencyTierLevel,
              matchedRuleName: matchedTieredRule.RuleName,
              matchedTierCommission,
              actualExcess: totalExcess,
              tenantId: tenantIdForAgency
            }, 'Commission');
          } else {
            // No matching tier - use standard overflow logic
            breakdown.tenants.push({
              entityType: 'Agency',
              tenantId: excessRecipientId, // Actually AgencyId
              amount: totalExcess,
              ruleId: null, // Overflow itself has no rule
              evaluatedRuleIds: evaluatedRuleIds.length > 0 ? evaluatedRuleIds : null,
              ruleName: excessRecipientName,
              isOverflow: true,
              isExcess: true,
              isPrimaryAgency: true
            });
          }
        } else {
          // Should not happen anymore (no fallback to Product Owner), but keep for safety
          breakdown.tenants.push({
            tenantId: excessRecipientId,
            amount: totalExcess,
            ruleId: null,
            evaluatedRuleIds: evaluatedRuleIds.length > 0 ? evaluatedRuleIds : null,
            ruleName: excessRecipientName,
            isOverflow: true,
            isExcess: true
          });
        }
      }
    }
    
    // Final validation: Commission pool should be fully distributed
    // Total commission payouts (agents + overflow) should equal the commission pool
    const totalCommissionDistributed = totalCommissionsPaidAfterSplit + totalExcess;
    if (Math.abs(totalCommissionDistributed - totalCommissionAllocation) > 0.01) { // Allow small rounding differences
      logger.warn('Commission pool not fully distributed', {
        totalCommissionAllocation,
        totalCommissionDistributed,
        difference: Math.abs(totalCommissionDistributed - totalCommissionAllocation),
        totalCommissionsPaidAfterSplit,
        totalExcess
      }, 'Commission');
    }
    
    // Note: Payment amount is fully allocated via NetRate (vendor) + OverrideRate (tenant) + CommissionPool (agents/overflow)
    // This validation ensures the commission pool itself is fully distributed

    const overflowToProductOwner = totalExcess;

    // Calculate remaining amount (for simulation, this is allocatedCommissionAmount - totalCommissionsPaid)
    // For actual payments, remainingAmount is the overflow (unallocated commission)
    // For simulations (paymentAmount = 0), use allocatedCommissionAmount - totalCommissionsPaidAfterSplit
    const allocatedCommissionAmount = totalCommissionAllocation;
    const remainingAmount = paymentAmount > 0 
      ? totalExcess // Overflow is the remaining unallocated commission
      : allocatedCommissionAmount - totalCommissionsPaidAfterSplit;
    
    // Calculate total payouts for return value (vendor + override + commission pool fully distributed)
    // Note: This is informational only - validation now checks commission pool distribution, not total payouts
    const totalPayouts = vendorAmountPaid + overrideAmountPaid + totalCommissionDistributed;
    
    logger.info('💰 Final commission calculation summary', {
      allocatedCommissionAmount,
      totalCommissionsPaidAfterSplit,
      remainingAmount,
      paymentAmount,
      totalPayouts,
      overflowToProductOwner,
      totalCommissionDistributed,
      calculation: `${allocatedCommissionAmount} - ${totalCommissionsPaidAfterSplit} = ${remainingAmount} (overflow)`
    }, 'Commission');

    return {
      breakdown,
      totalCommissionsPaid: totalCommissionsPaidAfterSplit, // Use value after split rules
      vendorCommissionPaid: vendorAmountPaid,
      totalPayouts: totalPayouts,
      remainingAmount: remainingAmount,
      overflowToProductOwner,
      allocatedCommissionAmount // Include for frontend calculation
    };
  }

  /**
   * Get agent commission chain: selling agent first, then upline (for tier distribution).
   * Used so tiered rules can pay the selling agent their tier amount and upline their differential.
   * @param {string} agentId - Selling agent ID
   * @returns {Promise<Array>} Chain: [{ agentId, parentId, tierLevel, hierarchyTierLevel }, ...] (selling agent first, then upline by tier)
   */
  async getAgentUpline(agentId) {
    const pool = await getPool();

    // Get selling agent's CommissionTierLevel (so we include them in the chain for tier distribution)
    const sellingAgentRequest = pool.request();
    sellingAgentRequest.input('AgentId', sql.UniqueIdentifier, agentId);
    const sellingAgentResult = await sellingAgentRequest.query(`
      SELECT COALESCE(cl.SortOrder, a.CommissionTierLevel, 0) as TierLevel
      FROM oe.Agents a
      LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId AND cl.IsActive = 1
      WHERE AgentId = @AgentId
    `);
    const sellingAgentTierLevel = sellingAgentResult.recordset.length > 0
      ? (sellingAgentResult.recordset[0].TierLevel ?? 0)
      : 0;

    const request = pool.request();
    request.input('AgentId', sql.UniqueIdentifier, agentId);

    // oe.fn_GetAgentUplineForCommission walks oe.AgentHierarchy upward and
    // returns BOTH agent rows and agency rows. The "AgentId" column is a
    // generic entity id — for top-of-tree members the row is actually an
    // AgencyId pointing into oe.Agencies. We classify each row by joining
    // both tables (LEFT JOIN) and using the table that resolves it.
    const result = await request.query(`
      SELECT
        u.AgentId AS EntityId,
        u.ParentId,
        u.TierLevel as HierarchyTierLevel,
        a.AgentId AS MatchedAgentId,
        a.CommissionLevelId AS AgentCommissionLevelId,
        COALESCE(cl.SortOrder, a.CommissionTierLevel) AS AgentTierLevel,
        ag.AgencyId AS MatchedAgencyId,
        ag.CommissionLevelId AS AgencyCommissionLevelId,
        ag.CommissionTierLevel AS AgencyRawTierLevel,
        COALESCE(agcl.SortOrder, ag.CommissionTierLevel) AS AgencyTierLevel
      FROM oe.fn_GetAgentUplineForCommission(@AgentId) u
      LEFT JOIN oe.Agents a ON u.AgentId = a.AgentId
      LEFT JOIN oe.CommissionLevels cl ON a.CommissionLevelId = cl.CommissionLevelId AND cl.IsActive = 1
      LEFT JOIN oe.Agencies ag ON u.AgentId = ag.AgencyId AND ag.Status = 'Active'
      LEFT JOIN oe.CommissionLevels agcl ON ag.CommissionLevelId = agcl.CommissionLevelId AND agcl.IsActive = 1
      ORDER BY u.TierLevel ASC
    `);

    // Build a single hierarchy-ordered chain. Each row classified as Agent or
    // Agency based on which table resolved its EntityId.
    const upline = [];
    for (const row of result.recordset) {
      const entityId = row.EntityId ? row.EntityId.toString() : null;
      if (!entityId) continue;
      if (row.MatchedAgentId) {
        upline.push({
          entityType: 'Agent',
          agentId: entityId,
          agencyId: null,
          parentId: row.ParentId ? row.ParentId.toString() : null,
          tierLevel: row.AgentTierLevel != null ? Number(row.AgentTierLevel) : 0,
          hierarchyTierLevel: row.HierarchyTierLevel
        });
      } else if (row.MatchedAgencyId) {
        // Skip agencies that have no commission level configured ("None" in UI).
        if (row.AgencyCommissionLevelId == null && row.AgencyRawTierLevel == null) continue;
        upline.push({
          entityType: 'Agency',
          agentId: null,
          agencyId: entityId,
          parentId: row.ParentId ? row.ParentId.toString() : null,
          tierLevel: row.AgencyTierLevel != null ? Number(row.AgencyTierLevel) : 0,
          hierarchyTierLevel: row.HierarchyTierLevel
        });
      }
      // Rows that match neither table are dropped (stale hierarchy reference).
    }

    // Prepend selling agent so the chain is [selling agent, ...upline].
    const chain = [
      {
        entityType: 'Agent',
        agentId,
        agencyId: null,
        parentId: null,
        tierLevel: sellingAgentTierLevel,
        hierarchyTierLevel: sellingAgentTierLevel
      },
      ...upline
    ];

    // Dedupe by entity id (rare repeated rows from hierarchy walks).
    const seenIds = new Set();
    const uniqueChain = chain.filter((entry) => {
      const id = entry?.agentId
        ? `agent:${entry.agentId.toString()}`
        : entry?.agencyId
          ? `agency:${entry.agencyId.toString()}`
          : '';
      if (!id || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    console.log('🔍 Agent commission chain (selling agent + upline + agencies):', {
      agentId,
      chain: uniqueChain.map(a => ({
        entityType: a.entityType,
        agentId: a.agentId,
        agencyId: a.agencyId,
        tierLevel: a.tierLevel,
        hierarchyTierLevel: a.hierarchyTierLevel
      }))
    });

    return uniqueChain;
  }

  /**
   * Calculate tiered commission for a rule
   * @param {Object} rule - Commission rule
   * @param {Array} agentUpline - Agent hierarchy
   * @param {number} availableCommission - Available commission
   * @param {number} commissionPool - Commission pool (rules apply to this amount, not payment)
   * @returns {Promise<number>} Commission amount for this rule
   */
  async calculateTieredCommission(rule, agentUpline, availableCommission, commissionPool) {
    const tierLevel = rule.TierLevel || 0;
    const agent = agentUpline.find(a => a.tierLevel === tierLevel);

    if (!agent) {
      return 0; // No agent at this tier level
    }

    // Calculate from commission pool, not payment amount
    const percentage = rule.CommissionRate || 0;
    // Spirytus is stored as decimal (0.4 = 40%), but if it's > 1, treat as percentage > 100
    if (percentage > 1) {
      // Legacy: if percentage is > 1, it's a raw percentage value (e.g., 40 for 40%)
      return Math.min(availableCommission, commissionPool * (percentage / 100));
    } else {
      // Decimal format (e.g., 0.4 for 40%)
      return Math.min(availableCommission, commissionPool * percentage);
    }
  }

  /**
   * Calculate complex tiered commission from CommissionJson
   * @param {Object} rule - Commission rule with CommissionJson
   * @param {Array} agentUpline - Agent hierarchy
   * @param {number} availableCommission - Available commission
   * @param {number} commissionPool - Commission pool amount
   * @param {string} productTier - Product tier (EE, ES, EC, EF) - optional
   * @returns {Promise<number>} Total commission for this tiered rule
   */
  async calculateComplexTieredCommission(rule, agentUpline, availableCommission, commissionPool, productTier = null, enrollmentCount = null, productEnrollmentCounts = null, ruleProductId = null) {
    if (!rule.CommissionJson) {
      console.log('⚠️ No CommissionJson in rule:', rule.RuleId);
      return 0;
    }

    try {
      const commissionConfig = typeof rule.CommissionJson === 'string'
        ? JSON.parse(rule.CommissionJson)
        : rule.CommissionJson;

      let totalTieredCommission = 0;
      const commissionType = commissionConfig.type || 'percentage'; // 'flatrate' or 'percentage'
      
      console.log('🔍 calculateComplexTieredCommission:', {
        ruleName: rule.RuleName,
        commissionType,
        productTier,
        tiersCount: commissionConfig.tiers?.length,
        agentUplineLength: agentUpline?.length,
        enrollmentCount: enrollmentCount,
        fullCommissionConfig: JSON.stringify(commissionConfig, null, 2).substring(0, 2000) // Limit to first 2000 chars
      });

      // Check for product-tier specific rates first
      if (productTier && commissionConfig.productTiers && commissionConfig.productTiers[productTier]) {
        const productTierConfig = commissionConfig.productTiers[productTier];
        if (commissionType === 'percentage' && productTierConfig.rate !== undefined) {
          const rate = productTierConfig.rate > 1 ? productTierConfig.rate / 100 : productTierConfig.rate;
          return Math.min(availableCommission, commissionPool * rate);
        } else if (commissionType === 'flatrate' && productTierConfig.flatAmount !== undefined) {
          return Math.min(availableCommission, productTierConfig.flatAmount);
        }
      }

      // Process each tier in the configuration
      // First aggregate duplicate tier levels (same level, same agent)
      let tierAggregates = null;
      if (commissionConfig.tiers && Array.isArray(commissionConfig.tiers)) {
        // Aggregate tiers by level and agent to handle duplicates
        tierAggregates = new Map();
        
        console.log('🔍 Processing tiers:', {
          tiersCount: commissionConfig.tiers.length,
          agentUpline: agentUpline.map(a => ({ tierLevel: a.tierLevel, agentId: a.agentId })),
          tiers: commissionConfig.tiers.map(t => ({
            tierLevel: t.tierLevel || t.level || 0,
            flatAmount: t.flatAmount,
            amount: t.amount, // Check if it's 'amount' instead of 'flatAmount'
            rate: t.rate,
            percentage: t.percentage,
            allFields: Object.keys(t) // Show all fields in the tier object
          }))
        });
        
        for (const tier of commissionConfig.tiers) {
          const tierLevel = tier.tierLevel || tier.level || 0;
          const agent = agentUpline.find(a => a.tierLevel === tierLevel);
          
          console.log('🔍 Checking tier:', {
            tierLevel,
            hasAgent: !!agent,
            agentId: agent?.agentId,
            flatAmount: tier.flatAmount,
            amount: tier.amount,
            rate: tier.rate,
            percentage: tier.percentage,
            allFields: Object.keys(tier),
            fullTier: JSON.stringify(tier)
          });

          if (agent) {
            // Key includes either agentId or agencyId so multiple distinct
            // recipients at the same tier level (mixed agent/agency chain)
            // accumulate independently.
            const recipientId = agent.agentId || agent.agencyId || 'unknown';
            const key = `${tierLevel}-${recipientId}`;

            if (!tierAggregates.has(key)) {
              tierAggregates.set(key, {
                tierLevel,
                agent,
                totalRate: 0,
                totalFlatAmount: 0
              });
            }
            
            const aggregate = tierAggregates.get(key);
            
            // Use type from config or default to percentage
            const tierType = commissionConfig.type || 'percentage';
            
            // Check for product tier-specific rates/amounts first
            if (productTier && tier.productTiers && tier.productTiers[productTier]) {
              const productTierConfig = tier.productTiers[productTier];
              if (tierType === 'percentage' && productTierConfig.rate !== undefined) {
                const rate = productTierConfig.rate > 1 ? productTierConfig.rate / 100 : productTierConfig.rate;
                aggregate.totalRate += rate;
              } else if (tierType === 'flatrate' && productTierConfig.flatAmount !== undefined) {
                aggregate.totalFlatAmount += productTierConfig.flatAmount;
              } else {
                // Fallback to base tier rate/amount if product tier config doesn't have the needed field
            if (tierType === 'percentage') {
              if (tier.rate !== undefined) {
                const rate = tier.rate > 1 ? tier.rate / 100 : tier.rate;
                    aggregate.totalRate += rate;
                  } else if (tier.percentage !== undefined) {
                    const rate = tier.percentage > 1 ? tier.percentage / 100 : tier.percentage;
                    aggregate.totalRate += rate;
                  }
                } else if (tierType === 'flatrate') {
                  // Check both 'flatAmount' and 'amount' field names (some rules use 'amount')
                  const flatAmount = tier.flatAmount !== undefined ? tier.flatAmount : (tier.amount !== undefined ? tier.amount : 0);
                  aggregate.totalFlatAmount += flatAmount;
                  if (flatAmount > 0) {
                    console.log('💰 Adding flat amount for tier:', {
                      tierLevel,
                      flatAmount: tier.flatAmount,
                      amount: tier.amount,
                      finalFlatAmount: flatAmount,
                      totalFlatAmount: aggregate.totalFlatAmount
                    });
                  }
                }
              }
            } else {
              // No product tier specified or no product tier config, use base tier rate/amount
              // BUT: If tier has productTiers but no productTier was selected, use average or first product tier amount for flatrate
              if (tier.productTiers && tierType === 'flatrate') {
                // For flatrate rules with productTiers but no productTier selected, use average of all product tier amounts
                const productTierAmounts = Object.values(tier.productTiers)
                  .map(pt => pt.flatAmount)
                  .filter(amt => amt !== undefined && amt !== null && amt > 0);
                
                if (productTierAmounts.length > 0) {
                  // Use average of all product tier amounts
                  const avgAmount = productTierAmounts.reduce((sum, amt) => sum + amt, 0) / productTierAmounts.length;
                  aggregate.totalFlatAmount += avgAmount;
                  console.log('💰 Using average product tier amount (no product tier selected):', {
                    tierLevel,
                    productTierAmounts,
                    averageAmount: avgAmount,
                    totalFlatAmount: aggregate.totalFlatAmount
                  });
                } else {
                  // Fallback to base flatAmount if product tiers don't have amounts
                  const flatAmount = tier.flatAmount !== undefined ? tier.flatAmount : (tier.amount !== undefined ? tier.amount : 0);
                  aggregate.totalFlatAmount += flatAmount;
                  if (flatAmount > 0) {
                    console.log('💰 Adding flat amount for tier (no product tier):', {
                      tierLevel,
                      flatAmount: tier.flatAmount,
                      amount: tier.amount,
                      finalFlatAmount: flatAmount,
                      totalFlatAmount: aggregate.totalFlatAmount
                    });
                  }
                }
              } else if (tierType === 'percentage') {
                if (tier.rate !== undefined) {
                  const rate = tier.rate > 1 ? tier.rate / 100 : tier.rate;
                  aggregate.totalRate += rate;
              } else if (tier.percentage !== undefined) {
                // Legacy support for 'percentage' field
                const rate = tier.percentage > 1 ? tier.percentage / 100 : tier.percentage;
                  aggregate.totalRate += rate;
              }
            } else if (tierType === 'flatrate') {
                // Check both 'flatAmount' and 'amount' field names (some rules use 'amount')
                const flatAmount = tier.flatAmount !== undefined ? tier.flatAmount : (tier.amount !== undefined ? tier.amount : 0);
                aggregate.totalFlatAmount += flatAmount;
                if (flatAmount > 0) {
                  console.log('💰 Adding flat amount for tier (no product tier):', {
                    tierLevel,
                    flatAmount: tier.flatAmount,
                    amount: tier.amount,
                    finalFlatAmount: flatAmount,
                    totalFlatAmount: aggregate.totalFlatAmount
                  });
                }
              }
            }
          }
        }
        
        console.log('🔍 Tier aggregates:', {
          aggregatesCount: tierAggregates.size,
          aggregates: Array.from(tierAggregates.values()).map(a => ({
            tierLevel: a.tierLevel,
            agentId: a.agent?.agentId,
            totalRate: a.totalRate,
            totalFlatAmount: a.totalFlatAmount
          }))
        });

        // Tiered hierarchy: total = TOP tier amount only (not sum of all tiers).
        // Distribution is differential in applyRule (each agent gets their tier amount minus the tier below).
        const tierLevelsPresent = Array.from(tierAggregates.values()).map(a => a.tierLevel);
        const maxTierLevel = tierLevelsPresent.length > 0 ? Math.max(...tierLevelsPresent) : 0;
        const topAggregate = Array.from(tierAggregates.values()).find(a => a.tierLevel === maxTierLevel);
        if (!topAggregate) {
          console.log('⚠️ No aggregate for max tier level:', maxTierLevel);
        } else {
          const aggregate = topAggregate;
          let tierAmount = 0;
          const tierType = commissionConfig.type || 'percentage';

          if (tierType === 'percentage') {
            tierAmount = commissionPool * aggregate.totalRate;
          } else if (tierType === 'flatrate') {
            let tierDistribution = null;
            if (productEnrollmentCounts && ruleProductId) {
              const tierDistKey = `TIER_DIST:${ruleProductId.toString().toUpperCase()}`;
              if (productEnrollmentCounts.has(tierDistKey)) {
                tierDistribution = productEnrollmentCounts.get(tierDistKey);
              }
            }
            if (tierDistribution && tierDistribution instanceof Map) {
              let totalTierAmount = 0;
              const tierConfig = commissionConfig.tiers.find(t => (t.tierLevel || t.level) === aggregate.tierLevel);
              if (tierConfig && tierConfig.productTiers) {
                for (const [tier, householdCount] of tierDistribution.entries()) {
                  const productTierConfig = tierConfig.productTiers[tier];
                  if (productTierConfig && productTierConfig.flatAmount !== undefined) {
                    totalTierAmount += (productTierConfig.flatAmount || 0) * householdCount;
                  }
                }
              }
              tierAmount = totalTierAmount;
            } else if (enrollmentCount && enrollmentCount > 0) {
              tierAmount = aggregate.totalFlatAmount * enrollmentCount;
            } else {
              tierAmount = aggregate.totalFlatAmount;
            }
          }
          totalTieredCommission = tierAmount;
          console.log('💰 Tiered rule total = top tier amount only (differential distribution in applyRule):', {
            maxTierLevel,
            tierAmount,
            totalTieredCommission
          });
        }

        console.log('🔍 After tier aggregation (top-tier total):', {
          totalTieredCommission,
          tierAggregatesSize: tierAggregates.size
        });
      } else {
        console.log('⚠️ No tiers array in commissionConfig');
      }

      console.log('🔍 Before final calculation:', {
        totalTieredCommission,
        availableCommission,
        commissionPool
      });

      const finalAmount = Math.min(availableCommission, totalTieredCommission);
      console.log('💰 calculateComplexTieredCommission result:', {
        totalTieredCommission,
        availableCommission,
        finalAmount,
        commissionPool,
        willReturn: finalAmount
      });
      
      return finalAmount;
    } catch (error) {
      logger.error('Error parsing CommissionJson', { error: error.message, ruleId: rule.RuleId }, 'Commission');
      return 0;
    }
  }

  /**
   * Apply a commission rule and distribute amounts
   * @param {Object} rule - Commission rule
   * @param {string} agentId - Selling agent ID
   * @param {Array} agentUpline - Agent hierarchy
   * @param {number} ruleAmount - Amount for this rule
   * @param {Object} product - Product details
   * @returns {Promise<Array>} Distribution array
   */
  async applyRule(rule, agentId, agentUpline, ruleAmount, product, commissionPool = null, productTier = null) {
    const distribution = [];

    switch (rule.EntityType) {
      case 'Agent':
        // Direct agent commission
        // If EntityId is NULL, apply to the selling agent; otherwise check if it matches
        if (rule.EntityId === null || rule.EntityId === agentId) {
          distribution.push({
            entityType: 'Agent',
            entityId: agentId, // Always use the selling agent ID
            amount: ruleAmount,
            tierLevel: 0
          });
        }
        break;

      case 'Tier':
        // Tier-based distribution
        // If CommissionType is 'Tiered', parse CommissionJson and distribute to all tiers
        // Also handle EntityType='Tier' with CommissionJson (for tiered rules)
        if ((rule.CommissionType === 'Tiered' || (rule.EntityType === 'Tier' && rule.CommissionJson)) && rule.CommissionJson) {
          console.log('🔍 Processing Tier rule with CommissionJson:', {
            ruleName: rule.RuleName,
            commissionType: rule.CommissionType,
            entityType: rule.EntityType,
            hasCommissionJson: !!rule.CommissionJson,
            agentUplineLength: agentUpline?.length
          });
          try {
            const commissionConfig = typeof rule.CommissionJson === 'string'
              ? JSON.parse(rule.CommissionJson)
              : rule.CommissionJson;
            
            if (commissionConfig.tiers && Array.isArray(commissionConfig.tiers)) {
              const commissionType = commissionConfig.type || 'percentage';
              
              // Aggregate tiers by level to handle duplicates
              // Map: tierLevel -> { agent, totalRate, totalFlatAmount }
              const tierAggregates = new Map();
              
              for (const tier of commissionConfig.tiers) {
                const tierLevel = tier.tierLevel || tier.level || 0;
        const agent = agentUpline.find(a => a.tierLevel === tierLevel);
                
                if (agent && commissionPool !== null) {
                  const recipientId = agent.agentId || agent.agencyId || 'unknown';
                  const key = `${tierLevel}-${recipientId}`;

                  if (!tierAggregates.has(key)) {
                    tierAggregates.set(key, {
                      tierLevel,
                      agent,
                      totalRate: 0,
                      totalFlatAmount: 0
                    });
                  }
                  
                  const aggregate = tierAggregates.get(key);
                  
                  // Check for product tier-specific rates/amounts first
                  if (productTier && tier.productTiers && tier.productTiers[productTier]) {
                    const productTierConfig = tier.productTiers[productTier];
                    if (commissionType === 'percentage' && productTierConfig.rate !== undefined) {
                      const rate = productTierConfig.rate > 1 ? productTierConfig.rate / 100 : productTierConfig.rate;
                      aggregate.totalRate += rate;
                    } else if (commissionType === 'flatrate' && productTierConfig.flatAmount !== undefined) {
                      aggregate.totalFlatAmount += productTierConfig.flatAmount;
                    } else {
                      // Fallback to base tier rate/amount if product tier config doesn't have the needed field
                      if (commissionType === 'percentage') {
                        const rate = tier.rate !== undefined ? tier.rate : tier.percentage;
                        if (rate !== undefined) {
                          const tierRate = rate > 1 ? rate / 100 : rate;
                          aggregate.totalRate += tierRate;
                        }
                      } else if (commissionType === 'flatrate') {
                        // Check both 'flatAmount' and 'amount' field names
                        const flatAmount = tier.flatAmount !== undefined ? tier.flatAmount : (tier.amount !== undefined ? tier.amount : 0);
                        aggregate.totalFlatAmount += flatAmount;
                      }
                    }
                  } else {
                    // No product tier specified or no product tier config, use base tier rate/amount
                    // BUT: If tier has productTiers but no productTier was selected, use average or first product tier amount for flatrate
                    if (tier.productTiers && commissionType === 'flatrate') {
                      // For flatrate rules with productTiers but no productTier selected, use average of all product tier amounts
                      const productTierAmounts = Object.values(tier.productTiers)
                        .map(pt => pt.flatAmount)
                        .filter(amt => amt !== undefined && amt !== null && amt > 0);
                      
                      if (productTierAmounts.length > 0) {
                        // Use average of all product tier amounts
                        const avgAmount = productTierAmounts.reduce((sum, amt) => sum + amt, 0) / productTierAmounts.length;
                        aggregate.totalFlatAmount += avgAmount;
                        console.log('💰 Using average product tier amount (no product tier selected in applyRule):', {
                          tierLevel,
                          productTierAmounts,
                          averageAmount: avgAmount,
                          totalFlatAmount: aggregate.totalFlatAmount
                        });
                      } else {
                        // Fallback to base flatAmount if product tiers don't have amounts
                        aggregate.totalFlatAmount += (tier.flatAmount || 0);
                      }
                    } else if (commissionType === 'percentage') {
                      const rate = tier.rate !== undefined ? tier.rate : tier.percentage;
                      if (rate !== undefined) {
                        const tierRate = rate > 1 ? rate / 100 : rate;
                        aggregate.totalRate += tierRate;
                      }
                    } else if (commissionType === 'flatrate') {
                      aggregate.totalFlatAmount += (tier.flatAmount || 0);
                    }
                  }
                }
              }
              
              // Differential tier distribution: each agent gets (their tier amount - tier amount below).
              // Chain = agentUpline (selling agent first, then upline). Sort by tier level ascending.
              const amountForLevel = new Map(); // tierLevel -> configured amount for that level
              for (const aggregate of tierAggregates.values()) {
                let amt = 0;
                if (commissionType === 'percentage') {
                  amt = commissionPool * aggregate.totalRate;
                } else if (commissionType === 'flatrate') {
                  amt = aggregate.totalFlatAmount;
                }
                amountForLevel.set(aggregate.tierLevel, amt);
              }
              // Preserve chain order as returned (seller -> direct upline -> next),
              // and defensively dedupe repeated entries. Chain may contain Agent
              // and Agency entries — dedupe by whichever id is present.
              const seenChainIds = new Set();
              const sortedChain = [...agentUpline].filter((entry) => {
                const id = entry?.agentId
                  ? entry.agentId.toString()
                  : entry?.entityType === 'Agency' && entry.agencyId
                    ? `agency:${entry.agencyId.toString()}`
                    : '';
                if (!id || seenChainIds.has(id)) return false;
                seenChainIds.add(id);
                return true;
              });
              let prevLevelAmount = 0;
              const differentialAmounts = []; // { agent, amount }
              for (const agent of sortedChain) {
                const level = agent.tierLevel ?? 0;
                const levelAmount = amountForLevel.get(level) ?? 0;
                const diffAmount = Math.max(0, levelAmount - prevLevelAmount);
                prevLevelAmount = levelAmount;
                differentialAmounts.push({ agent, amount: diffAmount });
              }
              const totalDifferential = differentialAmounts.reduce((sum, d) => sum + d.amount, 0);
              // Do NOT proportionally split a short pool across uplines.
              // If the pool is short, pay down the chain in order and stop when money runs out.
              // We only scale UP when ruleAmount exceeds the configured differential total
              // (e.g., group tier multiplication already applied in calculateComplexTieredCommission).
              const shouldScaleUp = totalDifferential > 0 && ruleAmount > totalDifferential;
              const scaleFactor = shouldScaleUp ? (ruleAmount / totalDifferential) : 1;
              const adjustedDifferentialAmounts = differentialAmounts.map((entry) => ({
                ...entry,
                amount: entry.amount * scaleFactor
              }));
              let remaining = ruleAmount;
              console.log('🔍 Differential tier distribution:', {
                sortedChain: sortedChain.map(a => ({ agentId: a.agentId, tierLevel: a.tierLevel })),
                amountForLevel: Object.fromEntries(amountForLevel),
                totalDifferential,
                ruleAmount,
                scaleFactor,
                shouldScaleUp
              });
              const isPayableChainEntry = (a) => !!(a && (a.agentId || (a.entityType === 'Agency' && a.agencyId)));
              const payableEntries = adjustedDifferentialAmounts.filter(({ agent, amount }) => isPayableChainEntry(agent) && amount > 0);
              for (let i = 0; i < payableEntries.length; i++) {
                const { agent, amount } = payableEntries[i];
                if (remaining <= 0 || !isPayableChainEntry(agent)) break;

                const targetAmount = Math.round(amount * 100) / 100;
                let payAmount = 0;

                if (remaining + 0.000001 < targetAmount) {
                  // Pool is short: pay remainder to current level and stop.
                  // Do not continue to split the shortfall across higher levels.
                  payAmount = Math.round(remaining * 100) / 100;
                  remaining = 0;
                } else {
                  payAmount = targetAmount;
                  remaining = Math.round((remaining - payAmount) * 100) / 100;
                  // If we intentionally scaled up, let the last payable line absorb rounding dust.
                  if (shouldScaleUp && i === payableEntries.length - 1 && remaining > 0) {
                    payAmount = Math.round((payAmount + remaining) * 100) / 100;
                    remaining = 0;
                  }
                }
                if (payAmount > 0) {
                  const isAgency = agent.entityType === 'Agency' && agent.agencyId;
                  distribution.push({
                    entityType: isAgency ? 'Agency' : 'Agent',
                    entityId: isAgency ? agent.agencyId : agent.agentId,
                    amount: payAmount,
                    tierLevel: agent.tierLevel ?? 0
                  });
                  console.log('✅ Differential tier entry:', {
                    entityType: isAgency ? 'Agency' : 'Agent',
                    entityId: isAgency ? agent.agencyId : agent.agentId,
                    tierLevel: agent.tierLevel,
                    amount: payAmount,
                    remaining
                  });
                  if (remaining <= 0) break;
                }
              }
            } else {
              // Fallback to single tier level if no tiers in config.
              // Chain entries can be Agent or Agency; emit accordingly.
              const ruleTierLevel = rule.TierLevel || 0;
              const match = agentUpline.find(a => a.tierLevel === ruleTierLevel);
              const isAgency = match && match.entityType === 'Agency' && match.agencyId;
              if (match && (match.agentId || isAgency)) {
                distribution.push({
                  entityType: isAgency ? 'Agency' : 'Agent',
                  entityId: isAgency ? match.agencyId : match.agentId,
                  amount: ruleAmount,
                  tierLevel: match.tierLevel
                });
              }
            }
          } catch (error) {
            logger.error('Error parsing tiered commission config in applyRule', {
              error: error.message,
              ruleId: rule.RuleId
            }, 'Commission');
            // Fallback to single tier level
            const ruleTierLevel = rule.TierLevel || 0;
            const match = agentUpline.find(a => a.tierLevel === ruleTierLevel);
            const isAgency = match && match.entityType === 'Agency' && match.agencyId;
            if (match && (match.agentId || isAgency)) {
              distribution.push({
                entityType: isAgency ? 'Agency' : 'Agent',
                entityId: isAgency ? match.agencyId : match.agentId,
                amount: ruleAmount,
                tierLevel: match.tierLevel
              });
            }
          }
        } else {
          // Single tier level distribution (legacy or simple tier rule)
          const ruleTierLevel = rule.TierLevel || 0;
          const match = agentUpline.find(a => a.tierLevel === ruleTierLevel);
          const isAgency = match && match.entityType === 'Agency' && match.agencyId;
          if (match && (match.agentId || isAgency)) {
            distribution.push({
              entityType: isAgency ? 'Agency' : 'Agent',
              entityId: isAgency ? match.agencyId : match.agentId,
              amount: ruleAmount,
              tierLevel: match.tierLevel
            });
          }
        }
        break;

      case 'Split':
        // Split commission - Primary Agent and multiple other agents
        if (rule.CommissionJson) {
          try {
            const commissionConfig = typeof rule.CommissionJson === 'string'
              ? JSON.parse(rule.CommissionJson)
              : rule.CommissionJson;

            if (commissionConfig.splitCommission) {
              const splitConfig = commissionConfig.splitCommission;
              const totalPercentage = splitConfig.totalPercentage || 1.0;

              // Primary agent gets their share
              if (splitConfig.primaryAgentId) {
                const primaryShare = splitConfig.primaryAgentId === agentId 
                  ? (splitConfig.agents?.find(a => a.agentId === agentId)?.percentage || 0)
                  : 0;
                
                if (primaryShare > 0) {
                  distribution.push({
                    entityType: 'Agent',
                    entityId: splitConfig.primaryAgentId,
                    amount: ruleAmount * primaryShare,
                    tierLevel: 0,
                    isPrimary: true
                  });
                }
              }

              // Other agents get their shares
              if (splitConfig.agents && Array.isArray(splitConfig.agents)) {
                for (const splitAgent of splitConfig.agents) {
                  // Skip primary agent if already added
                  if (splitAgent.agentId === splitConfig.primaryAgentId) {
                    continue;
                  }

                  const agentShare = splitAgent.percentage || 0;
                  if (agentShare > 0) {
                    distribution.push({
                      entityType: 'Agent',
                      entityId: splitAgent.agentId,
                      amount: ruleAmount * agentShare,
                      tierLevel: 0,
                      isPrimary: false
                    });
                  }
                }
              }
            }
          } catch (error) {
            logger.error('Error parsing split commission config', { 
              error: error.message, 
              ruleId: rule.RuleId 
            }, 'Commission');
          }
        }
        break;

      case 'Vendor':
        // Vendor commission
        if (product.VendorId) {
          distribution.push({
            entityType: 'Vendor',
            entityId: product.VendorId,
            amount: ruleAmount,
            tierLevel: null
          });
        }
        break;

      case 'Tenant':
        // Tenant commission
        if (product.ProductOwnerId) {
          distribution.push({
            entityType: 'Tenant',
            entityId: product.ProductOwnerId,
            amount: ruleAmount,
            tierLevel: null
          });
        }
        break;

      case 'Override':
        // Commission Override - distributes to specific agents/agencies
        // Override rules can target specific agents via agentid (preferred) or EntityId (backward compatibility), or use CommissionJson for complex distributions
        const overrideAgentId = rule.agentid || rule.EntityId; // Use agentid if available, fallback to EntityId for backward compatibility
        if (overrideAgentId) {
          // Specific agent override
          distribution.push({
            entityType: 'Agent',
            entityId: overrideAgentId,
            amount: ruleAmount,
            tierLevel: 0
          });
        } else if (rule.CommissionJson) {
          // Complex override distribution from CommissionJson
          try {
            const commissionConfig = typeof rule.CommissionJson === 'string'
              ? JSON.parse(rule.CommissionJson)
              : rule.CommissionJson;

            if (commissionConfig.overrideAgents && Array.isArray(commissionConfig.overrideAgents)) {
              // Distribute to multiple override agents
              for (const overrideAgent of commissionConfig.overrideAgents) {
                const agentId = overrideAgent.agentId;
                const percentage = overrideAgent.percentage || 0;
                const flatAmount = overrideAgent.flatAmount || 0;
                
                let agentAmount = 0;
                if (flatAmount > 0) {
                  agentAmount = flatAmount;
                } else if (percentage > 0) {
                  agentAmount = ruleAmount * (percentage > 1 ? percentage / 100 : percentage);
                }

                if (agentAmount > 0 && agentId) {
                  distribution.push({
                    entityType: 'Agent',
                    entityId: agentId,
                    amount: agentAmount,
                    tierLevel: 0
                  });
                }
              }
            } else {
              // Default: apply to selling agent if no specific configuration
              distribution.push({
                entityType: 'Agent',
                entityId: agentId,
                amount: ruleAmount,
                tierLevel: 0
              });
            }
          } catch (error) {
            logger.error('Error parsing override commission config', { 
              error: error.message, 
              ruleId: rule.RuleId 
            }, 'Commission');
            // Fallback: apply to selling agent
            distribution.push({
              entityType: 'Agent',
              entityId: agentId,
              amount: ruleAmount,
              tierLevel: 0
            });
          }
        } else {
          // No EntityId or CommissionJson - apply to selling agent
          distribution.push({
            entityType: 'Agent',
            entityId: agentId,
            amount: ruleAmount,
            tierLevel: 0
          });
        }
        break;

      case 'Agency':
        // Agency commission - can be paid to agency or distributed to agents
        if (rule.EntityId) {
          // Specific agency - could be stored as tenant or handled differently
          // For now, treat as tenant distribution
          distribution.push({
            entityType: 'Agency',
            entityId: rule.EntityId,
            amount: ruleAmount,
            tierLevel: null
          });
        } else {
          // No specific agency - could distribute to upline or default behavior
          // Default: treat as tenant distribution
          if (product.ProductOwnerId) {
            distribution.push({
              entityType: 'Agency',
              entityId: product.ProductOwnerId,
              amount: ruleAmount,
              tierLevel: null
            });
          }
        }
        break;
    }

    return distribution;
  }

  /**
   * Calculate commissions for multiple payments (batch processing)
   * @param {Array} payments - Array of payment objects
   * @returns {Promise<Array>} Array of commission calculations
   */
  async calculateBatchCommissions(payments) {
    const results = [];

    for (const payment of payments) {
      try {
        const productId = payment?.productId || null;
        if (!productId) {
          throw new Error('Missing productId for batch commission calculation');
        }
        const calculation = await this.calculateCommissions(
          payment.PaymentId,
          productId,
          payment.Amount,
          payment.AgentId,
          payment.TenantId,
          payment.EnrollmentId || null,
          payment.OverrideAmount || 0,
          payment.CommissionAmount || null,
          payment.VendorCommissionAmount || null
        );
        results.push(calculation);
      } catch (error) {
        logger.error('Error calculating commission for payment', {
          error: error.message,
          paymentId: payment.PaymentId
        }, 'Commission');
        results.push({
          paymentId: payment.PaymentId,
          error: error.message
        });
      }
    }

    return results;
  }
}

module.exports = new CommissionCalculatorService();


