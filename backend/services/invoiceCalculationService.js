/**
 * Invoice Calculation Service
 *
 * Reuses calculation logic from MonthlyPaymentScheduler for estimated invoice calculations
 * This ensures consistency between actual invoice generation and preview calculations
 */

const processingFeeCalculator = require('../utils/processingFeeCalculator');
const { requireShared } = require('../config/shared-modules');
const { resolveProcessingFeeTotalFromParts } = requireShared('payment-product-snapshots');

/**
 * Calculate total monthly amount for a group including system fees
 * @param {number} basePremium - Total of all enrollment premiums
 * @param {number} householdCount - Number of unique households in the group
 * @param {Object} systemFeesSettings - Parsed SystemFees from oe.Tenants.SystemFees
 * @returns {number} Total monthly amount (premium + system fees per household)
 */
function calculateGroupMonthlyTotal(basePremium, householdCount, systemFeesSettings) {
  if (!systemFeesSettings || householdCount === 0) {
    return basePremium;
  }

  // Calculate average premium per household (for percentage-based fees)
  const averagePremiumPerHousehold = basePremium / householdCount;

  let totalSystemFees = 0;
  const feeTypes = ['platformFee', 'mobileAppFee', 'aiAssistantFee'];

  feeTypes.forEach(feeType => {
    const fee = systemFeesSettings[feeType];

    // Skip if not enabled or not member-paid
    if (!fee || !fee.enabled || !fee.MemberPaid) {
      return;
    }

    let feeAmountPerHousehold = 0;

    if (fee.FlatOrPercent === 'Percent') {
      // Percentage-based - calculate from average household premium
      const percentageValue = fee.MemberPaidAmount || fee.amount || 0;
      feeAmountPerHousehold = (averagePremiumPerHousehold * percentageValue) / 100;
    } else {
      // Flat fee per household
      feeAmountPerHousehold = fee.MemberPaidAmount !== undefined && fee.MemberPaidAmount !== null 
        ? fee.MemberPaidAmount 
        : fee.amount || 0;
    }

    // Multiply by household count to get total for all households
    const totalFeeForAllHouseholds = feeAmountPerHousehold * householdCount;
    totalSystemFees += totalFeeForAllHouseholds;
  });

  const totalAmount = Math.round((basePremium + totalSystemFees) * 100) / 100;

  return totalAmount;
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
  const subtotalWithSystemFees = calculateGroupMonthlyTotal(
    basePremium,
    householdCount,
    systemFeesSettings
  );
  
  const systemFeesAmount = Math.round((subtotalWithSystemFees - basePremium) * 100) / 100;
  
  // Processing fee via the canonical primitive — same function pricingAuthority
  // calls internally. This keeps invoice preview math and authority enrollment
  // math pinned to a single source of truth.
  // Note: map 'CreditCard' → 'Card' so the primitive receives the shape it
  // expects (it only understands 'ACH' | 'Card' | 'Highest'). The primitive
  // handles percentage normalization (0.03 vs 3) and ceil-to-cent rounding
  // internally.
  const paymentProcessingFee = paymentProcessorSettings?.chargeFeeToMember
    ? Number(processingFeeCalculator.calculateProcessingFee(
        subtotalWithSystemFees,
        paymentMethodType === 'CreditCard' ? 'Card' : paymentMethodType,
        paymentProcessorSettings
      ) || 0)
    : 0;
  
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

/** Cache when column exists (avoids COL_LENGTH each request). If missing, re-check each call until migration. */
let cachedPremiumReportingCategoryColumnExists = false;

async function productsHasPremiumReportingCategoryColumn(pool) {
  if (cachedPremiumReportingCategoryColumnExists) {
    return true;
  }
  const r = await pool.request().query(`
    SELECT COL_LENGTH('oe.Products', 'PremiumReportingCategory') AS colLen
  `);
  const len = r.recordset[0]?.colLen;
  const exists = len != null && len !== undefined;
  if (exists) {
    cachedPremiumReportingCategoryColumnExists = true;
  }
  return exists;
}

/**
 * Calculate premiums for each location in a group
 * @param {object} pool - Database pool
 * @param {string} groupId - Group ID
 * @param {Date|{year:number,month:number}|{periodStart:Date,periodEnd:Date}} billingPeriod -
 *   Calendar month (Date or { year, month }) OR explicit cohort period ({ periodStart, periodEnd }).
 *   When periodStart+periodEnd are supplied they take precedence and are used as the
 *   exact inclusive boundaries for the SQL filters (cohort-aware, e.g. 15→14).
 * @param {object} sql - mssql module instance
 * @returns {Promise<Array>} Array of location premium objects
 */
async function calculateLocationPremiums(pool, groupId, billingPeriod, sql) {
  try {
    const hasPremiumReportingCategory = await productsHasPremiumReportingCategoryColumn(pool);
    const npFpSelectLines = hasPremiumReportingCategory
      ? `SUM(CASE WHEN (e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product') AND ISNULL(p.PremiumReportingCategory, 'ForProfit') = 'NonProfit' THEN ISNULL(e.PremiumAmount, 0) ELSE 0 END) AS BasePremiumNonProfit,
          SUM(CASE WHEN (e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product') AND ISNULL(p.PremiumReportingCategory, 'ForProfit') = 'ForProfit' THEN ISNULL(e.PremiumAmount, 0) ELSE 0 END) AS BasePremiumForProfit,`
      : `CAST(0 AS DECIMAL(18, 2)) AS BasePremiumNonProfit,
          SUM(CASE WHEN e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product' THEN ISNULL(e.PremiumAmount, 0) ELSE 0 END) AS BasePremiumForProfit,`;

    const request = pool.request();
    request.input('groupId', sql.UniqueIdentifier, groupId);

    // Detect explicit cohort period: { periodStart, periodEnd }.
    // When present it takes precedence over calendar (year,month) mapping.
    const explicitPeriodStart =
      billingPeriod && typeof billingPeriod === 'object' && !(billingPeriod instanceof Date)
        ? billingPeriod.periodStart
        : undefined;
    const explicitPeriodEnd =
      billingPeriod && typeof billingPeriod === 'object' && !(billingPeriod instanceof Date)
        ? billingPeriod.periodEnd
        : undefined;
    const useExplicit = Boolean(explicitPeriodStart && explicitPeriodEnd);

    // Use integer year/month + DATEFROMPARTS in SQL so the billing calendar month never shifts
    // when a JS Date was previously bound as DateTime2 (UTC vs local moved EOMONTH / comparisons).
    let billingYear;
    let billingMonth;
    if (useExplicit) {
      // Explicit cohort period path — year/month come from the period start for
      // any remaining @billingYear/@billingMonth references that aren't boundary
      // filters (currently none, but bound for parity/defensive correctness).
      const ps = explicitPeriodStart instanceof Date
        ? explicitPeriodStart
        : new Date(explicitPeriodStart);
      billingYear = ps.getUTCFullYear();
      billingMonth = ps.getUTCMonth() + 1;
    } else if (
      billingPeriod &&
      typeof billingPeriod === 'object' &&
      !(billingPeriod instanceof Date) &&
      Number.isFinite(billingPeriod.year) &&
      Number.isFinite(billingPeriod.month)
    ) {
      billingYear = Math.floor(Number(billingPeriod.year));
      billingMonth = Math.floor(Number(billingPeriod.month));
    } else {
      const d =
        billingPeriod instanceof Date ? billingPeriod : new Date(billingPeriod || Date.now());
      // Invoice / billing dates are stored in UTC; local getMonth() shifts UTC midnight
      // (e.g. May 1 00:00Z) to the prior calendar month in US timezones and wrong premiums
      // are shown on group invoice PDFs (see calculateLocationPremiums callers).
      billingYear = d.getUTCFullYear();
      billingMonth = d.getUTCMonth() + 1;
    }
    if (billingMonth < 1 || billingMonth > 12) {
      throw new Error(`Invalid billing month: ${billingMonth}`);
    }
    request.input('billingYear', sql.Int, billingYear);
    request.input('billingMonth', sql.Int, billingMonth);

    if (useExplicit) {
      request.input('periodStart', sql.Date, explicitPeriodStart);
      request.input('periodEnd', sql.Date, explicitPeriodEnd);
    }

    const startSql = useExplicit
      ? '@periodStart'
      : 'DATEFROMPARTS(@billingYear, @billingMonth, 1)';
    const endSql = useExplicit
      ? '@periodEnd'
      : 'EOMONTH(DATEFROMPARTS(@billingYear, @billingMonth, 1))';

    // Query to calculate premiums by location
    // Based on primary member's LocationId (or fallback to primary location, then any group location)
    const query = `
      WITH LocationAssignments AS (
        -- Get primary member's location for each household
        SELECT DISTINCT
          h.HouseholdId,
          COALESCE(
            m.LocationId,
            primaryLoc.LocationId,
            (SELECT TOP 1 gl2.LocationId FROM oe.GroupLocations gl2 WHERE gl2.GroupId = h.GroupId ORDER BY gl2.IsPrimary DESC, gl2.Name)
          ) AS LocationId,
          primaryLoc.LocationId AS PrimaryLocationId
        FROM oe.Members h
        INNER JOIN oe.Members m ON h.HouseholdId = m.HouseholdId AND m.MemberSequence = 1
        LEFT JOIN oe.GroupLocations primaryLoc ON primaryLoc.GroupId = h.GroupId AND primaryLoc.IsPrimary = 1
        WHERE h.GroupId = @groupId
          AND h.Status != 'Terminated'
      ),
      LocationPremiums AS (
        SELECT 
          la.LocationId,
          ISNULL(gl.Name, 'Unknown Location') AS LocationName,
          ISNULL(gl.IsPrimary, 0) AS LocationIsPrimary,
          ISNULL(gl.UseLocationACH, 0) AS UseLocationACH,
          COUNT(DISTINCT CASE WHEN e.EnrollmentId IS NOT NULL THEN la.HouseholdId END) AS HouseholdCount,
          COUNT(DISTINCT CASE WHEN e.EnrollmentId IS NOT NULL THEN m.MemberId END) AS MemberCount,
          SUM(CASE WHEN e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product' THEN ISNULL(e.PremiumAmount, 0) ELSE 0 END) AS BasePremium,
          ${npFpSelectLines}
          SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee' THEN ISNULL(e.PremiumAmount, 0) ELSE 0 END) AS PpfRemainderOnFeeRows,
          SUM(CASE WHEN e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product'
            THEN ISNULL(e.IncludedPaymentProcessingFeeAmount, 0) ELSE 0 END) AS IncludedProcessingFeeOnProducts,
          SUM(CASE WHEN e.EnrollmentType = 'SystemFee' THEN ISNULL(e.PremiumAmount, 0) ELSE 0 END) AS SystemFeeAmount,
          SUM(CASE WHEN e.EnrollmentType = 'SetupFee'
            AND CAST(e.EffectiveDate AS DATE) <= ${endSql}
            AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) >= ${startSql})
            THEN ISNULL(e.PremiumAmount, 0) ELSE 0 END) AS UnpaidSetupFees
        FROM LocationAssignments la
        LEFT JOIN oe.GroupLocations gl ON la.LocationId = gl.LocationId
        LEFT JOIN oe.Members m ON la.HouseholdId = m.HouseholdId AND m.Status != 'Terminated'
        LEFT JOIN oe.Enrollments e ON m.MemberId = e.MemberId
          AND (e.EnrollmentType IS NULL OR e.EnrollmentType IN ('Product', 'PaymentProcessingFee', 'SystemFee', 'SetupFee'))
          AND CAST(e.EffectiveDate AS DATE) <= ${endSql}
          AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) >= ${startSql})
        LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
        WHERE la.LocationId IS NOT NULL
        GROUP BY la.LocationId, gl.Name, gl.IsPrimary, gl.UseLocationACH
      )
      SELECT 
        LocationId,
        LocationName,
        LocationIsPrimary,
        UseLocationACH,
        HouseholdCount,
        MemberCount,
        ISNULL(BasePremium, 0) AS BasePremium,
        ISNULL(BasePremiumNonProfit, 0) AS BasePremiumNonProfit,
        ISNULL(BasePremiumForProfit, 0) AS BasePremiumForProfit,
        ISNULL(PpfRemainderOnFeeRows, 0) AS PpfRemainderOnFeeRows,
        ISNULL(IncludedProcessingFeeOnProducts, 0) AS IncludedProcessingFeeOnProducts,
        ISNULL(SystemFeeAmount, 0) AS SystemFeeAmount,
        ISNULL(UnpaidSetupFees, 0) AS UnpaidSetupFees
      FROM LocationPremiums
      WHERE BasePremium > 0
        OR PpfRemainderOnFeeRows > 0
        OR IncludedProcessingFeeOnProducts > 0
        OR SystemFeeAmount > 0
        OR UnpaidSetupFees > 0
      ORDER BY LocationIsPrimary DESC, LocationName
    `;
    
    const result = await request.query(query);
    return (result.recordset || []).map((row) => {
      const ppf = resolveProcessingFeeTotalFromParts(
        row.IncludedProcessingFeeOnProducts,
        row.PpfRemainderOnFeeRows
      );
      return {
        ...row,
        PaymentProcessingFeeAmount: ppf.total
      };
    });
  } catch (error) {
    console.error('❌ Error calculating location premiums:', error);
    throw error;
  }
}

const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * Per-product processing fees + other fee lines for group billing UI.
 *
 * @deprecated Reads `IncludedPaymentProcessingFeeAmount` for display breakdowns only.
 * Invoice amounts should use enrollment PremiumAmount sums (includedFeeDeprecation.js).
 */
async function calculateGroupBillingFeeBreakdown(pool, groupId, periodStart, periodEnd, sqlTypes = sql) {
  const ps = periodStart instanceof Date ? periodStart : new Date(periodStart);
  const pe = periodEnd instanceof Date ? periodEnd : new Date(periodEnd);

  const includedResult = await pool.request()
    .input('groupId', sqlTypes.UniqueIdentifier, groupId)
    .input('periodStart', sqlTypes.Date, ps)
    .input('periodEnd', sqlTypes.Date, pe)
    .query(`
      SELECT
        p.ProductId,
        p.Name AS ProductName,
        SUM(COALESCE(e.IncludedPaymentProcessingFeeAmount, 0)) AS IncludedProcessingFee
      FROM oe.Enrollments e
      INNER JOIN oe.Members m ON e.MemberId = m.MemberId
      INNER JOIN oe.Products p ON e.ProductId = p.ProductId
      WHERE m.GroupId = @groupId
        AND (e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product')
        AND e.ProductId IS NOT NULL
        AND e.ProductId <> '${ZERO_GUID}'
        AND CAST(e.EffectiveDate AS DATE) <= @periodEnd
        AND (e.TerminationDate IS NULL OR e.TerminationDate > @periodStart)
      GROUP BY p.ProductId, p.Name
      HAVING SUM(COALESCE(e.IncludedPaymentProcessingFeeAmount, 0)) > 0
      ORDER BY p.Name
    `);

  const feeTotalsResult = await pool.request()
    .input('groupId', sqlTypes.UniqueIdentifier, groupId)
    .input('periodStart', sqlTypes.Date, ps)
    .input('periodEnd', sqlTypes.Date, pe)
    .query(`
      SELECT
        ISNULL(SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee'
          THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END), 0) AS PpfRemainderOnFeeRows,
        ISNULL(SUM(CASE WHEN e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product'
          THEN COALESCE(e.IncludedPaymentProcessingFeeAmount, 0) ELSE 0 END), 0) AS IncludedOnProducts,
        ISNULL(SUM(CASE WHEN e.EnrollmentType = 'SystemFee'
          THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END), 0) AS SystemFeesTotal,
        ISNULL(SUM(CASE WHEN e.EnrollmentType = 'SetupFee'
          AND CAST(e.EffectiveDate AS DATE) <= @periodEnd
          AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) >= @periodStart)
          THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END), 0) AS SetupFeesTotal
      FROM oe.Enrollments e
      INNER JOIN oe.Members m ON e.MemberId = m.MemberId
      WHERE m.GroupId = @groupId
        AND CAST(e.EffectiveDate AS DATE) <= @periodEnd
        AND (e.TerminationDate IS NULL OR e.TerminationDate > @periodStart)
    `);

  const totalsRow = feeTotalsResult.recordset[0] || {};
  const ppf = resolveProcessingFeeTotalFromParts(
    totalsRow.IncludedOnProducts,
    totalsRow.PpfRemainderOnFeeRows
  );

  const processingFeeByProduct = (includedResult.recordset || []).map((row) => ({
    productId: row.ProductId,
    productName: row.ProductName || 'Product',
    amount: Math.round(parseFloat(row.IncludedProcessingFee || 0) * 100) / 100
  }));

  const includedSum = processingFeeByProduct.reduce((s, l) => s + l.amount, 0);
  const unattributed = Math.round((ppf.total - includedSum) * 100) / 100;
  if (unattributed > 0.005) {
    processingFeeByProduct.push({
      productId: null,
      productName: 'Group processing fee',
      amount: unattributed
    });
  }

  return {
    processingFeeByProduct,
    systemFeesTotal: Math.round(parseFloat(totalsRow.SystemFeesTotal || 0) * 100) / 100,
    setupFeesTotal: Math.round(parseFloat(totalsRow.SetupFeesTotal || 0) * 100) / 100
  };
}

module.exports = {
  calculateGroupMonthlyTotal,
  calculateLocationFees,
  calculateLocationPremiums,
  calculateGroupBillingFeeBreakdown
};

