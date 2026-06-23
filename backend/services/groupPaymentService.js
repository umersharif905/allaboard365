const { getPool, sql } = require('../config/database');
const DimeService = require('./dimeService');
const PaymentMethodService = require('./PaymentMethodService');
const {
  COHORT_FIRST,
  getChargeDayForCohort
} = require('../utils/billingCohort');

/**
 * Ensures a DIME customer and a recurring payment plan exist for a group.
 * Creates them if they don't exist.
 * @param {string} groupId - The ID of the group.
 * @param {string|null} paymentMethodId - Optional DIME payment method ID to use. If null, attempts to find default.
 * @param {string|null} effectiveDate - Optional effective date for the first enrollment. Used to derive next billing date.
 * @param {string} [cohort=COHORT_FIRST] - Billing cohort ('FIRST' or 'FIFTEENTH'). Determines BillingDay (5 vs 20) and the day-of-month used for NextBillingDate.
 * @returns {Promise<Object>} Result indicating success, planId, and message.
 */
async function ensureGroupRecurringPaymentPlan(groupId, paymentMethodId = null, effectiveDate = null, cohort = COHORT_FIRST) {
  const billingDay = getChargeDayForCohort(cohort);
  const pool = await getPool();
  let transaction;
  try {
    transaction = pool.transaction();
    await transaction.begin();

    // 1. Get group details
    const groupQuery = `
      SELECT 
        g.ProcessorCustomerId, 
        g.Name as GroupName,
        g.PrimaryContact,
        g.ContactEmail,
        g.ContactPhone,
        g.TenantId
      FROM oe.Groups g
      WHERE g.GroupId = @groupId
    `;
    const groupResult = await transaction.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(groupQuery);

    if (groupResult.recordset.length === 0) {
      await transaction.rollback();
      return { success: false, message: 'Group not found' };
    }
    const group = groupResult.recordset[0];

    let dimeCustomerId = group.ProcessorCustomerId;
    let currentPaymentMethodId = paymentMethodId;

    // 2. Ensure DIME Customer exists
    if (!dimeCustomerId) {
      console.log(`🔍 No DIME customer for group ${groupId}, creating one...`);
      const customerData = {
        firstName: group.PrimaryContact?.split(' ')[0] || 'Group',
        lastName: group.PrimaryContact?.split(' ').slice(1).join(' ') || 'Admin',
        email: group.ContactEmail || 'group@example.com',
        phone: group.ContactPhone || '+17707892072',
        billingAddress: '', // Placeholder, will be updated with actual payment method
        billingCity: '',
        billingState: '',
        billingZip: '',
        billingCountry: 'US'
      };
      const customerResult = await PaymentMethodService.ensureDimeCustomer(customerData, 'group', groupId, transaction);
      if (!customerResult.success) {
        await transaction.rollback();
        return { success: false, message: `Failed to create DIME customer: ${customerResult.message}` };
      }
      dimeCustomerId = customerResult.customerId;
      // Update group with new ProcessorCustomerId
      await transaction.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('customerId', sql.NVarChar(255), dimeCustomerId)
        .query(`UPDATE oe.Groups SET ProcessorCustomerId = @customerId, ModifiedDate = GETUTCDATE() WHERE GroupId = @groupId`);
      console.log(`✅ DIME customer ${dimeCustomerId} created for group ${groupId}`);
    }

    // 3. Ensure Payment Method exists (if not provided, try to find default)
    if (!currentPaymentMethodId) {
      const defaultPaymentMethodQuery = `
        SELECT ProcessorPaymentMethodId 
        FROM oe.GroupPaymentMethods 
        WHERE GroupId = @groupId AND IsDefault = 1 AND Status = 'Active'
      `;
      const defaultPaymentMethodResult = await transaction.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(defaultPaymentMethodQuery);
      currentPaymentMethodId = defaultPaymentMethodResult.recordset[0]?.ProcessorPaymentMethodId;
    }

    if (!currentPaymentMethodId) {
      await transaction.rollback();
      return { success: false, message: 'No default payment method found for group. Please add one via the billing tab.' };
    }

    // 4. Check if a recurring payment plan exists for THIS cohort. Mixed-cohort groups
    // (1st-of-month + 15th-of-month households) maintain one plan row per cohort.
    const existingPlanResult = await transaction.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('cohort', sql.NVarChar(20), cohort)
      .query(`
        SELECT TOP 1 PlanId, DimeScheduleId
        FROM oe.GroupRecurringPaymentPlans
        WHERE GroupId = @groupId AND Cohort = @cohort AND IsActive = 1
        ORDER BY CreatedDate DESC
      `);
    let recurringPaymentPlanId = existingPlanResult.recordset[0]?.DimeScheduleId || null;
    const existingPlanForCohort = existingPlanResult.recordset[0] || null;

    // Calculate cohort-specific total premium.
    const totalPremiumResult = await transaction.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('cohort', sql.NVarChar(20), cohort)
      .query(`EXEC oe.sp_CalculateGroupTotalPremium @GroupId = @groupId, @BillingDate = NULL, @Cohort = @cohort`);

    const currentTotalPremium = totalPremiumResult.recordset[0]?.TotalPremium || 0;

    if (!existingPlanForCohort && currentTotalPremium > 0) {
      console.log(`🔍 No ${cohort}-cohort recurring plan for group ${groupId} but has $${currentTotalPremium} in ${cohort}-cohort premiums`);
      console.log(`💡 DIME recurring payments for groups are handled by monthly Azure function - updating database tracking only...`);

      // Determine start date for recurring payment (cohort charge day of month after effectiveDate)
      let startDate = new Date();
      if (effectiveDate) {
        const effDate = new Date(effectiveDate);
        startDate = new Date(effDate.getFullYear(), effDate.getMonth() + 1, billingDay); // charge day of next month
        if (startDate <= new Date()) { // If charge day of next month is already past, use month after that
          startDate.setMonth(startDate.getMonth() + 1);
        }
      } else {
        // If no effective date, default to cohort charge day of next month
        startDate.setDate(billingDay);
        if (startDate <= new Date()) {
          startDate.setMonth(startDate.getMonth() + 1);
        }
      }

      // Insert plan row tagged with this cohort. DIME schedule is created by the
      // monthly Azure function (groupPaymentScheduler) on the next cohort run.
      await transaction.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('startDate', sql.DateTime2, startDate)
        .input('amount', sql.Decimal(10,2), currentTotalPremium)
        .input('billingDay', sql.Int, billingDay)
        .input('cohort', sql.NVarChar(20), cohort)
        .query(`
          INSERT INTO oe.GroupRecurringPaymentPlans (
            PlanId, GroupId, DimeScheduleId, MonthlyAmount, BillingDay,
            NextBillingDate, IsActive, Cohort, CreatedDate, ModifiedDate
          ) VALUES (
            NEWID(), @groupId, NULL, @amount, @billingDay,
            @startDate, 1, @cohort, GETUTCDATE(), GETUTCDATE()
          )
        `);
      console.log(`✅ Created ${cohort}-cohort tracking record for group ${groupId} (DIME schedule will be created by monthly Azure function)`);
      recurringPaymentPlanId = null;
    } else if (!existingPlanForCohort && currentTotalPremium === 0) {
      console.log(`⏸️ Group ${groupId} has no active ${cohort}-cohort enrollments yet, skipping plan creation`);
    }

    await transaction.commit();
    return { success: true, planId: recurringPaymentPlanId, message: 'Recurring payment plan ensured' };

  } catch (error) {
    if (transaction && transaction.aborted) {
      console.warn('Transaction already aborted, skipping rollback.');
    } else if (transaction) {
      await transaction.rollback();
    }
    console.error('❌ Error in ensureGroupRecurringPaymentPlan:', error);
    return { success: false, message: error.message, error: error };
  }
}

/**
 * Calculates the total premium for a group and updates the database tracking.
 * NOTE: This does NOT update DIME directly - that happens via scheduled job on 1st of month.
 * This prevents race conditions and ensures billing cycle integrity.
 * 
 * @param {string} groupId - The ID of the group.
 * @param {sql.Transaction|null} transaction - Optional SQL transaction object.
 * @param {string} [cohort=COHORT_FIRST] - Billing cohort ('FIRST' or 'FIFTEENTH'). Determines BillingDay (5 vs 20).
 * @returns {Promise<Object>} Result indicating success, new amount, and active enrollment count.
 */
async function updateGroupRecurringPaymentAmount(groupId, transaction = null, cohort = COHORT_FIRST) {
  const billingDay = getChargeDayForCohort(cohort);
  const maxRetries = 3;
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
    const pool = transaction || await getPool();

    // Cohort-filtered total premium (only enrollments matching this cohort).
    const totalResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('billingDate', sql.DateTime2, null)
      .input('cohort', sql.NVarChar(20), cohort)
      .execute('oe.sp_CalculateGroupTotalPremium');

    const totalPremium = totalResult.recordset[0]?.TotalPremium || 0;
    const activeEnrollmentCount = totalResult.recordset[0]?.ActiveEnrollmentCount || 0;

    // Look up THIS cohort's plan row only. Sibling-cohort plans are independent.
    const groupResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('cohort', sql.NVarChar(20), cohort)
      .query(`
        SELECT
          grp.PlanId,
          grp.DimeScheduleId,
          grp.MonthlyAmount,
          grp.NextBillingDate,
          g.ProcessorCustomerId,
          gpm.ProcessorPaymentMethodId
        FROM oe.GroupRecurringPaymentPlans grp WITH (UPDLOCK, HOLDLOCK)
        INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
        LEFT JOIN oe.GroupPaymentMethods gpm ON g.GroupId = gpm.GroupId AND gpm.IsDefault = 1 AND gpm.Status = 'Active'
        WHERE grp.GroupId = @groupId AND grp.Cohort = @cohort AND grp.IsActive = 1
      `);

    const group = groupResult.recordset[0];

    // No active plan exists for this cohort yet → insert a tracking row. The DIME
    // schedule itself is created by the monthly scheduler on the next cohort run.
    if (!group) {
      if (totalPremium === 0) {
        console.log(`⏸️ Group ${groupId} has no active ${cohort}-cohort enrollments — nothing to track yet`);
        return {
          success: true,
          planId: null,
          amount: 0,
          activeEnrollmentCount: 0,
          message: `No ${cohort}-cohort enrollments`,
        };
      }
      console.log(`🔍 No ${cohort}-cohort plan found for group ${groupId} ($${totalPremium} in premiums)`);

      const insertRequest = transaction ? transaction.request() : pool.request();
      await insertRequest
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('amount', sql.Decimal(10,2), totalPremium)
        .input('billingDay', sql.Int, billingDay)
        .input('billingDate', sql.DateTime2, new Date(new Date().getFullYear(), new Date().getMonth() + 1, billingDay))
        .input('cohort', sql.NVarChar(20), cohort)
        .query(`
          INSERT INTO oe.GroupRecurringPaymentPlans (
            PlanId, GroupId, DimeScheduleId, MonthlyAmount, BillingDay,
            NextBillingDate, IsActive, Cohort, CreatedDate, ModifiedDate
          ) VALUES (
            NEWID(), @groupId, NULL, @amount, @billingDay,
            @billingDate, 1, @cohort, GETUTCDATE(), GETUTCDATE()
          )
        `);

      console.log(`✅ Created ${cohort}-cohort tracking record for group ${groupId} (DIME schedule will be created by monthly scheduler)`);
      return {
        success: true,
        planId: null,
        amount: totalPremium,
        activeEnrollmentCount,
        cohort,
        message: 'Database tracking updated - DIME schedule will be created by monthly scheduler',
      };
    }

    // Plan exists for this cohort.
    if (group.MonthlyAmount === totalPremium) {
      console.log(`  ℹ️ Group ${groupId} ${cohort}-cohort amount unchanged ($${totalPremium}), no database update needed`);
      return {
        success: true,
        planId: group.DimeScheduleId,
        amount: totalPremium,
        activeEnrollmentCount,
        cohort,
        message: 'Payment amount is already up to date',
      };
    }

    // Update only this cohort's plan amount; sibling cohorts are untouched.
    await pool.request()
      .input('planId', sql.UniqueIdentifier, group.PlanId)
      .input('newAmount', sql.Decimal(10,2), totalPremium)
      .query(`
        UPDATE oe.GroupRecurringPaymentPlans
        SET MonthlyAmount = @newAmount, ModifiedDate = GETUTCDATE()
        WHERE PlanId = @planId
      `);

    console.log(`✅ Updated group ${groupId} ${cohort}-cohort plan: $${group.MonthlyAmount} → $${totalPremium} (DIME sync on next cohort run)`);

    return {
      success: true,
      planId: group.DimeScheduleId,
      amount: totalPremium,
      activeEnrollmentCount,
      previousAmount: group.MonthlyAmount,
      cohort,
      message: 'Database tracking updated (DIME will sync on next cohort run)',
      pendingDimeSync: true,
    };
    } catch (error) {
      attempt++;
      console.warn(`⚠️ Attempt ${attempt}/${maxRetries} failed for updateGroupRecurringPaymentAmount:`, error.message);
      
      // Check if this is a concurrency-related error that we should retry
      if (attempt < maxRetries && (
        error.message.includes('deadlock') ||
        error.message.includes('timeout') ||
        error.message.includes('concurrent') ||
        error.code === 'EREQUEST' ||
        error.number === 1205 // Deadlock victim
      )) {
        // Wait a random amount of time before retrying (exponential backoff)
        const delay = Math.random() * (100 * attempt); // 0-100ms, 0-200ms, 0-300ms
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // If it's not a retryable error or we've exhausted retries, throw the error
      throw error;
    }
  }
  
  // If we get here, all retries failed
  console.error('❌ All retry attempts failed for updateGroupRecurringPaymentAmount');
  return { 
    success: false, 
    message: 'Failed to update group recurring payment after multiple attempts', 
    error: 'Max retries exceeded'
  };
}

/**
 * Gets the payment status for a group including recurring payment plan details
 * @param {string} groupId - The ID of the group
 * @returns {Promise<Object>} Group payment status information
 */
async function getGroupPaymentStatus(groupId) {
  try {
    const pool = await getPool();
    
    const statusQuery = `
      SELECT 
        g.GroupId,
        g.Name as GroupName,
        grp.DimeScheduleId as RecurringPlanId,
        grp.MonthlyAmount,
        grp.NextBillingDate,
        grp.ModifiedDate as LastPaymentAmountUpdate,
        g.ProcessorCustomerId,
        COUNT(DISTINCT gpm.PaymentMethodId) as PaymentMethodCount,
        COUNT(DISTINCT e.EnrollmentId) as ActiveEnrollmentCount
      FROM oe.Groups g
      LEFT JOIN oe.GroupRecurringPaymentPlans grp ON g.GroupId = grp.GroupId AND grp.IsActive = 1
      LEFT JOIN oe.GroupPaymentMethods gpm ON g.GroupId = gpm.GroupId AND gpm.Status = 'Active'
      LEFT JOIN oe.Members m ON g.GroupId = m.GroupId
      LEFT JOIN oe.Enrollments e ON m.MemberId = e.MemberId 
        AND e.Status = 'Active' 
        AND e.EffectiveDate <= GETUTCDATE()
        AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
      WHERE g.GroupId = @groupId
      GROUP BY g.GroupId, g.Name, grp.DimeScheduleId, grp.MonthlyAmount, grp.NextBillingDate, grp.ModifiedDate, g.ProcessorCustomerId
    `;
    
    const result = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(statusQuery);
    
    if (result.recordset.length === 0) {
      return { success: false, message: 'Group not found' };
    }
    
    const group = result.recordset[0];
    
    return {
      success: true,
      data: {
        groupId: group.GroupId,
        groupName: group.GroupName,
        hasRecurringPlan: !!group.RecurringPlanId,
        recurringPlanId: group.RecurringPlanId,
        monthlyAmount: group.MonthlyAmount,
        nextBillingDate: group.NextBillingDate,
        lastAmountUpdate: group.LastPaymentAmountUpdate,
        hasDimeCustomer: !!group.ProcessorCustomerId,
        paymentMethodCount: group.PaymentMethodCount,
        activeEnrollmentCount: group.ActiveEnrollmentCount,
        isReadyForBilling: !!(group.ProcessorCustomerId && group.RecurringPlanId && group.PaymentMethodCount > 0)
      }
    };
  } catch (error) {
    console.error(`❌ Error in getGroupPaymentStatus for group ${groupId}:`, error);
    return { success: false, message: error.message, error: error };
  }
}

module.exports = {
  ensureGroupRecurringPaymentPlan,
  updateGroupRecurringPaymentAmount,
  getGroupPaymentStatus
};
