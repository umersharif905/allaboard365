const { getPool, sql } = require('../../config/database');

/**
 * UNIFIED PRICING SERVICE - Used by multiple endpoints
 * 
 * Endpoints using this service:
 * - /api/me/member/pricing (Member role)
 * - /api/members/:memberId/pricing (Admin roles)
 * 
 * This service provides consistent pricing calculations for both
 * group and individual members using the existing stored procedures.
 */
class PricingService {
  
  /**
   * Calculate member pricing based on tier and other factors
   * @param {string} memberId - Member ID to calculate pricing for
   * @param {object} params - Pricing parameters
   * @param {number} params.memberAge - Member age
   * @param {string} params.tobaccoUse - Tobacco use status
   * @param {string} params.memberTier - Member tier (EE, ES, EC, EF)
   * @param {Array} params.selectedProducts - Selected product IDs
   * @param {object} params.productConfigs - Product configuration data
   * @returns {object} Pricing calculation results
   */
  static async calculateMemberPricing(memberId, params) {
    try {
      const pool = await getPool();
      
      // Get member info to determine if group or individual
      const memberInfo = await this.getMemberInfo(memberId, pool);
      
      if (!memberInfo) {
        throw new Error('Member not found');
      }
      
      const isGroupMember = !!memberInfo.GroupId;
      
      console.log(`🔍 DEBUG: Calculating pricing for member ${memberId}, isGroupMember: ${isGroupMember}`);
      
      if (isGroupMember) {
        return await this.calculateGroupMemberPricing(memberId, params, memberInfo, pool);
      } else {
        return await this.calculateIndividualMemberPricing(memberId, params, memberInfo, pool);
      }
      
    } catch (error) {
      console.error('❌ ERROR in calculateMemberPricing:', error);
      throw error;
    }
  }
  
  /**
   * Get member information
   * @param {string} memberId - Member ID
   * @param {object} pool - Database pool
   * @returns {object} Member information
   */
  static async getMemberInfo(memberId, pool) {
    const request = pool.request();
    request.input('memberId', sql.UniqueIdentifier, memberId);
    
    const query = `
      SELECT 
        m.MemberId,
        m.GroupId,
        m.TenantId,
        m.DateOfBirth,
        m.TobaccoUse,
        m.RelationshipType,
        u.FirstName,
        u.LastName,
        u.Email,
        g.Name as GroupName,
        t.Name as TenantName
      FROM oe.Members m
      JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
      LEFT JOIN oe.Tenants t ON m.TenantId = t.TenantId
      WHERE m.MemberId = @memberId
    `;
    
    const result = await request.query(query);
    return result.recordset.length > 0 ? result.recordset[0] : null;
  }
  
  /**
   * Calculate pricing for group members using sp_CalculateGroupContributions
   * @param {string} memberId - Member ID
   * @param {object} params - Pricing parameters
   * @param {object} memberInfo - Member information
   * @param {object} pool - Database pool
   * @returns {object} Group pricing results
   */
  static async calculateGroupMemberPricing(memberId, params, memberInfo, pool) {
    const { memberAge, tobaccoUse, memberTier, selectedProducts, productConfigs } = params;
    
    const pricingResults = {};
    
    // For each selected product, calculate pricing
    for (const productId of selectedProducts) {
      const productConfig = productConfigs[productId];
      
      if (!productConfig) {
        console.warn(`⚠️ No product config found for product ${productId}`);
        continue;
      }
      
      try {
        const request = pool.request();
        request.input('GroupId', sql.UniqueIdentifier, memberInfo.GroupId);
        request.input('ProductPricingId', sql.UniqueIdentifier, productConfig.productPricingId);
        request.input('CoverageTier', sql.NVarChar, memberTier);
        request.input('EmployeeRole', sql.NVarChar, null);
        request.input('HireDate', sql.Date, null);
        request.input('Division', sql.NVarChar, null);
        request.input('EmploymentClass', sql.NVarChar, null);
        
        const contributionResult = await request.execute('oe.sp_CalculateGroupContributions');
        
        if (contributionResult.recordset.length > 0) {
          const contribution = contributionResult.recordset[0];
          
          pricingResults[productId] = {
            productId: productId,
            productName: productConfig.productName,
            tierType: memberTier,
            tobaccoStatus: tobaccoUse,
            memberAge: memberAge,
            monthlyPremium: parseFloat(contribution.MonthlyPremium) || 0,
            employerContribution: parseFloat(contribution.EmployerContribution) || 0,
            employeeContribution: parseFloat(contribution.EmployeeContribution) || 0,
            employerPercent: parseFloat(contribution.EmployerPercent) || 0,
            employeePercent: parseFloat(contribution.EmployeePercent) || 0,
            appliedRules: contribution.AppliedRules || 'No rules applied',
            isGroupMember: true
          };
          
          console.log(`✅ Group pricing calculated for product ${productId}:`, pricingResults[productId]);
        }
        
      } catch (error) {
        console.error(`❌ Error calculating group pricing for product ${productId}:`, error);
        throw error;
      }
    }
    
    return {
      memberId: memberId,
      memberInfo: memberInfo,
      isGroupMember: true,
      pricingResults: pricingResults,
      totalMonthlyPremium: Object.values(pricingResults).reduce((sum, pricing) => sum + pricing.monthlyPremium, 0),
      totalEmployeeContribution: Object.values(pricingResults).reduce((sum, pricing) => sum + pricing.employeeContribution, 0)
    };
  }
  
  /**
   * Calculate pricing for individual members using sp_CalculateIndividualContributions
   * @param {string} memberId - Member ID
   * @param {object} params - Pricing parameters
   * @param {object} memberInfo - Member information
   * @param {object} pool - Database pool
   * @returns {object} Individual pricing results
   */
  static async calculateIndividualMemberPricing(memberId, params, memberInfo, pool) {
    const { memberAge, tobaccoUse, memberTier, selectedProducts, productConfigs } = params;
    
    const pricingResults = {};
    
    // For each selected product, calculate pricing
    for (const productId of selectedProducts) {
      const productConfig = productConfigs[productId];
      
      if (!productConfig) {
        console.warn(`⚠️ No product config found for product ${productId}`);
        continue;
      }
      
      try {
        // First, find the correct ProductPricingId based on product, tier, and age
        const pricingLookupRequest = pool.request();
        pricingLookupRequest.input('ProductId', sql.UniqueIdentifier, productId);
        pricingLookupRequest.input('TierType', sql.NVarChar(10), memberTier);
        pricingLookupRequest.input('MemberAge', sql.Int, memberAge);
        
        const pricingLookupResult = await pricingLookupRequest.query(`
          SELECT TOP 1 ProductPricingId, NetRate, OverrideRate, MinAge, MaxAge
          FROM oe.ProductPricing 
          WHERE ProductId = @ProductId 
            AND TierType = @TierType 
            AND Status = 'Active'
            AND MinAge <= @MemberAge
          ORDER BY MinAge DESC
        `);
        
        if (pricingLookupResult.recordset.length === 0) {
          console.warn(`⚠️ No pricing found for product ${productId}, tier ${memberTier}, age ${memberAge}`);
          continue;
        }
        
        const pricingInfo = pricingLookupResult.recordset[0];
        console.log(`🔍 Found pricing for product ${productId}, tier ${memberTier}, age ${memberAge}:`, {
          ProductPricingId: pricingInfo.ProductPricingId,
          NetRate: pricingInfo.NetRate,
          OverrideRate: pricingInfo.OverrideRate,
          AgeRange: `${pricingInfo.MinAge}-${pricingInfo.MaxAge}`
        });
        
        // Check if member is part of a group
        if (memberInfo.GroupId) {
          console.log(`🏢 Member is part of group ${memberInfo.GroupId}, using GROUP stored procedure`);
          
          // Use group-based pricing stored procedure
          const request = pool.request();
          request.input('GroupId', sql.UniqueIdentifier, memberInfo.GroupId);
          request.input('ProductPricingId', sql.UniqueIdentifier, pricingInfo.ProductPricingId);
          request.input('CoverageTier', sql.NVarChar, memberTier);
          request.input('EmployeeRole', sql.NVarChar, null);
          request.input('HireDate', sql.Date, null);
          request.input('Division', sql.NVarChar, null);
          request.input('EmploymentClass', sql.NVarChar, null);
          
          const contributionResult = await request.execute('oe.sp_CalculateGroupContributions');
          
          if (contributionResult.recordset.length > 0) {
            const contribution = contributionResult.recordset[0];
            
            // Check for error messages from stored procedure
            if (contribution.ErrorMessage) {
              console.log(`⚠️ Group stored procedure returned error: ${contribution.ErrorMessage}`);
              throw new Error(`Group pricing error: ${contribution.ErrorMessage}`);
            }
            
            const monthlyPremium = parseFloat(contribution.MonthlyPremium) || 0;
            const employerContribution = parseFloat(contribution.EmployerContribution) || 0;
            const employeeContribution = parseFloat(contribution.EmployeeContribution) || 0;
            
            pricingResults[productId] = {
              productId: productId,
              productName: productConfig.productName,
              tierType: memberTier,
              tobaccoStatus: tobaccoUse,
              memberAge: memberAge,
              monthlyPremium: monthlyPremium,
              employerContribution: employerContribution,
              employeeContribution: employeeContribution,
              employerPercent: parseFloat(contribution.EmployerPercent) || 0,
              employeePercent: parseFloat(contribution.EmployeePercent) || 100,
              appliedRules: contribution.AppliedRules || 'Group-based tier pricing calculated',
              isGroupMember: true
            };
            
            console.log(`✅ Group-based tier pricing calculated for product ${productId}:`, pricingResults[productId]);
          }
        } else {
          console.log(`👤 Member is INDIVIDUAL (no group), using INDIVIDUAL stored procedure`);
          
          // Use individual member pricing stored procedure
          const request = pool.request();
          request.input('TenantId', sql.UniqueIdentifier, memberInfo.TenantId);
          request.input('ProductPricingId', sql.UniqueIdentifier, pricingInfo.ProductPricingId);
          
          console.log(`🔍 Calling oe.sp_CalculateIndividualContributions with parameters:`, {
            TenantId: memberInfo.TenantId,
            ProductPricingId: pricingInfo.ProductPricingId
          });
          
          const contributionResult = await request.execute('oe.sp_CalculateIndividualContributions');
          
          console.log(`🔍 Individual stored procedure result for ${productId}:`, {
            recordsetLength: contributionResult.recordset.length,
            firstRecord: contributionResult.recordset[0]
          });
          
          if (contributionResult.recordset.length > 0) {
            const contribution = contributionResult.recordset[0];
            
            // Check for error messages from stored procedure
            if (contribution.ErrorMessage) {
              console.log(`⚠️ Individual stored procedure returned error: ${contribution.ErrorMessage}`);
              throw new Error(`Individual pricing error: ${contribution.ErrorMessage}`);
            }
            
            const monthlyPremium = parseFloat(contribution.MonthlyPremium) || 0;
            const employerContribution = parseFloat(contribution.EmployerContribution) || 0;
            const employeeContribution = parseFloat(contribution.EmployeeContribution) || monthlyPremium; // Use monthlyPremium if no specific employee contribution
          
          pricingResults[productId] = {
            productId: productId,
            productName: productConfig.productName,
            tierType: memberTier,
            tobaccoStatus: tobaccoUse,
            memberAge: memberAge,
              monthlyPremium: monthlyPremium,
              employerContribution: employerContribution,
              employeeContribution: employeeContribution,
              employerPercent: parseFloat(contribution.EmployerPercent) || 0,
              employeePercent: parseFloat(contribution.EmployeePercent) || 100,
              appliedRules: contribution.AppliedRules || 'Individual member pricing calculated',
            isGroupMember: false
          };
          
          console.log(`✅ Individual pricing calculated for product ${productId}:`, pricingResults[productId]);
          }
        }
        
      } catch (error) {
        console.error(`❌ Error calculating individual pricing for product ${productId}:`, error);
        
        // Fallback to basic pricing for individual enrollments
        const baseRate = parseFloat(productConfig.netRate) + parseFloat(productConfig.overrideRate || 0);
        
        pricingResults[productId] = {
          productId: productId,
          productName: productConfig.productName,
          tierType: memberTier,
          tobaccoStatus: tobaccoUse,
          memberAge: memberAge,
          monthlyPremium: baseRate,
          employerContribution: 0,
          employeeContribution: baseRate,
          employerPercent: 0,
          employeePercent: 100,
          appliedRules: 'Fallback pricing applied',
          isGroupMember: false
        };
        
        console.log(`⚠️ Fallback pricing applied for product ${productId}:`, pricingResults[productId]);
      }
    }
    
    return {
      memberId: memberId,
      memberInfo: memberInfo,
      isGroupMember: false,
      pricingResults: pricingResults,
      totalMonthlyPremium: Object.values(pricingResults).reduce((sum, pricing) => sum + pricing.monthlyPremium, 0),
      totalEmployeeContribution: Object.values(pricingResults).reduce((sum, pricing) => sum + pricing.employeeContribution, 0)
    };
  }
  
  /**
   * Calculate next billing cycle date
   * @param {string} currentEffectiveDate - Current effective date
   * @returns {string} Next billing cycle date
   */
  static calculateNextBillingCycleDate(currentEffectiveDate) {
    const currentDate = new Date(currentEffectiveDate);
    const currentDay = currentDate.getDate();
    
    // Calculate next month
    const nextMonth = new Date(currentDate);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    
    // Handle edge cases (like 31st day)
    const daysInNextMonth = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate();
    const effectiveDay = Math.min(currentDay, daysInNextMonth);
    
    nextMonth.setDate(effectiveDay);
    
    return nextMonth.toISOString().split('T')[0]; // Return YYYY-MM-DD format
  }
}

module.exports = PricingService;
