// backend/services/NACHAService.holdPeriods.js
const { getPool, sql } = require('../config/database');
const { PAID_PAYMENT_STATUSES_SQL } = require('../constants/paymentStatuses');

/**
 * Check for payments excluded due to commission hold periods
 * Returns tenants that have hold periods affecting the selected date range
 */
async function getExcludedPaymentsDueToHoldPeriods(startDate, endDate, tenantId = null) {
  const pool = await getPool();
  const request = pool.request();
  
  request.input('StartDate', sql.DateTime2, startDate);
  request.input('EndDate', sql.DateTime2, endDate);
  
  let tenantFilter = '';
  if (tenantId) {
    request.input('TenantId', sql.UniqueIdentifier, tenantId);
    tenantFilter = 'AND t.TenantId = @TenantId';
  }

  // Query to find payments that would be excluded due to hold periods
  // A payment is excluded if: PaymentDate + holdDays (+ 1 if nextDay) > endDate
  // This means the payment is in the date range but not yet eligible
  // IMPORTANT: PaymentDate represents the successful payment date from the payment processor (Dime),
  //            not when the record was created in our database. This is correct for hold period calculations.
  const query = `
    WITH PaymentHoldPeriods AS (
      SELECT DISTINCT
        p.PaymentId,
        p.PaymentDate, -- Successful payment date (from Dime), used for hold period calculations
        p.Amount,
        -- For agent commissions, use the selling agent's tenant
        -- For vendor/product owner payouts, use the product owner's tenant
        COALESCE(a.TenantId, pr.ProductOwnerId) as RelevantTenantId,
        t.Name as TenantName,
        ISNULL(CAST(JSON_VALUE(t.AdvancedSettings, '$.commissions.holdDays') AS INT), 0) as HoldDays,
        ISNULL(JSON_VALUE(t.AdvancedSettings, '$.commissions.holdDaysCountFrom'), 'paymentDate') as HoldDaysCountFrom,
        DATEADD(day,
          ISNULL(CAST(JSON_VALUE(t.AdvancedSettings, '$.commissions.holdDays') AS INT), 0) + 
          CASE WHEN JSON_VALUE(t.AdvancedSettings, '$.commissions.holdDaysCountFrom') = 'nextDay' THEN 1 ELSE 0 END,
          CAST(p.PaymentDate AS DATE)
        ) as EligibilityDate
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
      LEFT JOIN oe.Agents a ON p.AgentId = a.AgentId
      LEFT JOIN oe.Tenants t ON t.TenantId = COALESCE(a.TenantId, pr.ProductOwnerId)
      WHERE p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
        AND (p.NACHAId IS NULL OR p.NACHAId = '00000000-0000-0000-0000-000000000000')
        AND CAST(p.PaymentDate AS DATE) >= CAST(@StartDate AS DATE)
        AND CAST(p.PaymentDate AS DATE) <= CAST(@EndDate AS DATE)
        AND t.AdvancedSettings IS NOT NULL
        AND CAST(JSON_VALUE(t.AdvancedSettings, '$.commissions.holdDays') AS INT) > 0
        ${tenantFilter}
    )
    SELECT 
      RelevantTenantId as TenantId,
      TenantName,
      HoldDays,
      HoldDaysCountFrom,
      COUNT(*) as ExcludedPaymentCount,
      SUM(Amount) as ExcludedAmount,
      MIN(PaymentDate) as EarliestPaymentDate,
      MAX(EligibilityDate) as LatestEligibilityDate
    FROM PaymentHoldPeriods
    WHERE EligibilityDate > CAST(@EndDate AS DATE)
    GROUP BY RelevantTenantId, TenantName, HoldDays, HoldDaysCountFrom
  `;

  try {
    const result = await request.query(query);
    return result.recordset.map(row => ({
      tenantId: row.TenantId?.toString(),
      tenantName: row.TenantName,
      holdDays: row.HoldDays || 0,
      holdDaysCountFrom: row.HoldDaysCountFrom || 'paymentDate',
      excludedPaymentCount: row.ExcludedPaymentCount || 0,
      excludedAmount: parseFloat(row.ExcludedAmount) || 0,
      earliestPaymentDate: row.EarliestPaymentDate,
      latestEligibilityDate: row.LatestEligibilityDate
    }));
  } catch (error) {
    console.error('Error checking excluded payments due to hold periods:', error);
    return [];
  }
}

module.exports = {
  getExcludedPaymentsDueToHoldPeriods
};

