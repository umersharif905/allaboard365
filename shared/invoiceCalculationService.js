/**
 * Shared Invoice Calculation Service
 * 
 * Used by both:
 * - oe_payment_manager/MonthlyPaymentScheduler (Azure Functions)
 * - backend/routes/groupBilling.js (Express API)
 * 
 * This ensures 100% consistency between actual invoice generation and estimated invoice calculations
 * 
 * FIXED: Uses DISTINCT enrollments to prevent double-counting when households have multiple members
 */

const premiumCalculator = require('./premiumCalculator');

/**
 * Calculate location premiums using the CORRECTED query that prevents double-counting
 * 
 * FIXED: Uses DISTINCT enrollments to prevent double-counting when households have multiple members
 * 
 * @param {object} pool - Database connection pool
 * @param {string} groupId - Group ID
 * @param {Date} billingDate - Billing date (for setup fees filtering)
 * @param {object} sqlModule - Optional mssql module (if not provided, will require it)
 * @returns {Promise<Array>} Array of location premium objects
 */
async function calculateLocationPremiums(pool, groupId, billingDate, sqlModule = null) {
  // Use provided sql module or require it
  // IMPORTANT: Pass the sql module from the caller to ensure we use the same mssql instance
  // This prevents module resolution issues when projects have separate node_modules
  const sql = sqlModule || require('mssql');
  
  // Ensure sql types are available
  if (!sql || typeof sql.UniqueIdentifier !== 'function') {
    throw new Error('mssql module not properly loaded - sql.UniqueIdentifier is not a function. Please pass sql module as 4th parameter.');
  }
  
  const query = `
    -- Get primary location for fallback
    DECLARE @PrimaryLocationId UNIQUEIDENTIFIER;
    SELECT TOP 1 @PrimaryLocationId = LocationId 
    FROM oe.GroupLocations 
    WHERE GroupId = @groupId AND IsPrimary = 1;
    
    -- Calculate premiums by location (primary member's LocationId determines billing)
    -- FIXED: Use DISTINCT enrollments to prevent double-counting from member joins
    -- Enrollment "active for billing month": EffectiveDate/TerminationDate only (do not use oe.Enrollments.Status)
    WITH EnrollmentPremiums AS (
      -- First, get distinct enrollments with their premiums (avoid double-counting from member joins)
      SELECT DISTINCT
        e.EnrollmentId,
        e.PremiumAmount,
        pm.HouseholdId,
        COALESCE(pm.LocationId, @PrimaryLocationId) as LocationId
      FROM oe.Members pm
      INNER JOIN oe.Enrollments e ON pm.HouseholdId = e.HouseholdId 
        AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        AND CAST(e.EffectiveDate AS DATE) <= EOMONTH(@billingDate)
        AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) >= @billingDate)
      WHERE pm.MemberSequence = 1  -- Primary member determines location
        AND pm.GroupId = @groupId
        AND pm.Status != 'Terminated'
    ),
    LocationMemberCounts AS (
      -- Calculate member counts per location (separate to avoid affecting premium sums)
      SELECT 
        COALESCE(pm.LocationId, @PrimaryLocationId) as LocationId,
        COUNT(DISTINCT m.MemberId) as MemberCount
      FROM oe.Members pm
      INNER JOIN oe.Members m ON pm.HouseholdId = m.HouseholdId
      WHERE pm.MemberSequence = 1  -- Primary member determines location
        AND pm.GroupId = @groupId
        AND pm.Status != 'Terminated'
        AND m.Status != 'Terminated'
      GROUP BY COALESCE(pm.LocationId, @PrimaryLocationId)
    ),
    LocationPremiums AS (
      SELECT 
        ep.LocationId,
        gl.Name as LocationName,
        gl.ContactName as LocationContactName,
        gl.ContactEmail as LocationContactEmail,
        gl.IsPrimary as LocationIsPrimary,
        gl.UseLocationACH as UseLocationACH,
        COUNT(DISTINCT ep.HouseholdId) as HouseholdCount,
        COALESCE(lmc.MemberCount, 0) as MemberCount,
        COUNT(DISTINCT ep.EnrollmentId) as EnrollmentCount,
        SUM(ep.PremiumAmount) as BasePremium
      FROM EnrollmentPremiums ep
      LEFT JOIN oe.GroupLocations gl ON ep.LocationId = gl.LocationId
      LEFT JOIN LocationMemberCounts lmc ON ep.LocationId = lmc.LocationId
      GROUP BY ep.LocationId, gl.Name, gl.ContactName, gl.ContactEmail, gl.IsPrimary, gl.UseLocationACH, lmc.MemberCount
    ),
    LocationSetupFees AS (
      SELECT 
        COALESCE(pm.LocationId, @PrimaryLocationId) as LocationId,
        SUM(e_setup.PremiumAmount) as UnpaidSetupFees,
        COUNT(e_setup.EnrollmentId) as NewEnrollmentsWithSetupFees
      FROM oe.Members pm
      INNER JOIN oe.Enrollments e_setup ON pm.HouseholdId = e_setup.HouseholdId 
        AND e_setup.EnrollmentType = 'SetupFee'
        AND CAST(e_setup.EffectiveDate AS DATE) <= EOMONTH(@billingDate)
        AND (e_setup.TerminationDate IS NULL OR CAST(e_setup.TerminationDate AS DATE) >= @billingDate)
      LEFT JOIN oe.GroupLocations gl ON COALESCE(pm.LocationId, @PrimaryLocationId) = gl.LocationId
      WHERE pm.MemberSequence = 1  -- Primary member determines location
        AND pm.GroupId = @groupId
        AND pm.Status != 'Terminated'
      GROUP BY COALESCE(pm.LocationId, @PrimaryLocationId)
    ),
    LocationPaymentProcessingFees AS (
      -- Get PaymentProcessingFee enrollments from database (actual fees stored, not recalculated)
      SELECT 
        COALESCE(pm.LocationId, @PrimaryLocationId) as LocationId,
        SUM(e_ppf.PremiumAmount) as PaymentProcessingFeeAmount
      FROM oe.Members pm
      INNER JOIN oe.Enrollments e_ppf ON pm.HouseholdId = e_ppf.HouseholdId 
        AND e_ppf.EnrollmentType = 'PaymentProcessingFee'
        AND CAST(e_ppf.EffectiveDate AS DATE) <= EOMONTH(@billingDate)
        AND (e_ppf.TerminationDate IS NULL OR CAST(e_ppf.TerminationDate AS DATE) >= @billingDate)
      WHERE pm.MemberSequence = 1  -- Primary member determines location
        AND pm.GroupId = @groupId
        AND pm.Status != 'Terminated'
      GROUP BY COALESCE(pm.LocationId, @PrimaryLocationId)
    ),
    LocationSystemFees AS (
      -- Get SystemFee enrollments from database (actual fees stored, not recalculated)
      SELECT 
        COALESCE(pm.LocationId, @PrimaryLocationId) as LocationId,
        SUM(e_sf.PremiumAmount) as SystemFeeAmount
      FROM oe.Members pm
      INNER JOIN oe.Enrollments e_sf ON pm.HouseholdId = e_sf.HouseholdId 
        AND e_sf.EnrollmentType = 'SystemFee'
        AND CAST(e_sf.EffectiveDate AS DATE) <= EOMONTH(@billingDate)
        AND (e_sf.TerminationDate IS NULL OR CAST(e_sf.TerminationDate AS DATE) >= @billingDate)
      WHERE pm.MemberSequence = 1  -- Primary member determines location
        AND pm.GroupId = @groupId
        AND pm.Status != 'Terminated'
      GROUP BY COALESCE(pm.LocationId, @PrimaryLocationId)
    )
    SELECT 
      lp.LocationId,
      lp.LocationName,
      lp.LocationContactName,
      lp.LocationContactEmail,
      lp.LocationIsPrimary,
      lp.UseLocationACH,
      lp.HouseholdCount,
      lp.MemberCount,
      lp.EnrollmentCount,
      lp.BasePremium,
      COALESCE(lsf.UnpaidSetupFees, 0) as UnpaidSetupFees,
      COALESCE(lsf.NewEnrollmentsWithSetupFees, 0) as NewEnrollmentsWithSetupFees,
      COALESCE(lppf.PaymentProcessingFeeAmount, 0) as PaymentProcessingFeeAmount,
      COALESCE(lsysf.SystemFeeAmount, 0) as SystemFeeAmount
    FROM LocationPremiums lp
    LEFT JOIN LocationSetupFees lsf ON lp.LocationId = lsf.LocationId
    LEFT JOIN LocationPaymentProcessingFees lppf ON lp.LocationId = lppf.LocationId
    LEFT JOIN LocationSystemFees lsysf ON lp.LocationId = lsysf.LocationId
    ORDER BY lp.LocationIsPrimary DESC, lp.LocationName
  `;
  
  // Execute query with parameters
  // Note: Using the sql module from the function scope ensures we use the same mssql instance
  const result = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('billingDate', sql.Date, billingDate)
    .query(query);
  
  return result.recordset;
}

/**
 * Calculate fees for a location
 * @param {number} basePremium - Base monthly premium
 * @param {number} householdCount - Number of households
 * @param {string} paymentMethodType - Payment method type (Card/ACH/CreditCard)
 * @param {object} systemFeesSettings - System fees settings
 * @param {object} paymentProcessorSettings - Payment processor settings
 * @param {number} unpaidSetupFees - Unpaid setup fees to include (default: 0)
 * @returns {object} Fee breakdown object
 */
function calculateLocationFees(basePremium, householdCount, paymentMethodType, systemFeesSettings, paymentProcessorSettings, unpaidSetupFees = 0) {
  // Calculate system fees
  const subtotalWithSystemFees = premiumCalculator.calculateGroupMonthlyTotal(
    basePremium,
    householdCount,
    systemFeesSettings
  );
  
  const systemFeesAmount = Math.round((subtotalWithSystemFees - basePremium) * 100) / 100;
  
  // Calculate payment processing fees
  let paymentProcessingFee = 0;
  
  if (paymentProcessorSettings?.chargeFeeToMember && paymentProcessorSettings?.processors?.openenroll?.fees) {
    const fees = paymentProcessorSettings.processors.openenroll.fees;
    const feeConfig = (paymentMethodType === 'Card' || paymentMethodType === 'CreditCard') ? fees.creditCard : fees.ach;
    
    if (feeConfig) {
      let percentageValue = feeConfig.percentageFee || 0;
      
      // Handle both decimal (0.0025 = 0.25%) and whole number (3 = 3%) formats
      if (percentageValue >= 1) {
        percentageValue = percentageValue / 100;
      }
      
      const percentageFee = subtotalWithSystemFees * percentageValue;
      const flatFee = feeConfig.flatFee || 0;
      // Processing fees ALWAYS round UP to nearest cent (e.g., $3.781 → $3.79, $3.780 → $3.78)
      paymentProcessingFee = Math.ceil((percentageFee + flatFee) * 100) / 100;
    }
  }
  
  // Round unpaid setup fees
  const setupFeesAmount = Math.round((unpaidSetupFees || 0) * 100) / 100;
  
  // Final amount includes: base premium + system fees + payment processing fees + unpaid setup fees
  const totalAmount = Math.round((subtotalWithSystemFees + paymentProcessingFee + setupFeesAmount) * 100) / 100;
  const processingFees = Math.round((systemFeesAmount + paymentProcessingFee) * 100) / 100;
  
  return {
    systemFeesAmount,
    paymentProcessingFee,
    setupFeesAmount,
    totalAmount,
    processingFees,
    subtotalWithSystemFees
  };
}

module.exports = {
  calculateLocationPremiums,
  calculateLocationFees
};

