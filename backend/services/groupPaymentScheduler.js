/**
 * Group Payment Scheduler Service
 *
 * Handles scheduled recurring payment amount updates for groups.
 *
 * Dual-cohort model:
 *   - FIRST cohort:     runs on the 1st; invoices cover the 1st–end-of-month; charges on the 5th.
 *   - FIFTEENTH cohort: runs on the 15th; invoices cover the 15th–14th; charges on the 20th.
 *     Only groups with Groups.AllowMidMonthEffective = 1 participate.
 *
 * This approach prevents:
 * - Race conditions from concurrent enrollment completions
 * - Mid-month payment schedule disruptions (for FIRST-cohort groups)
 * - Missed or duplicate billing cycles
 */

const { getPool, sql } = require('../config/database');
const DimeService = require('./dimeService');
const {
  COHORT_FIRST,
  COHORT_FIFTEENTH,
  getChargeDayForCohort
} = require('../utils/billingCohort');

/**
 * Returns the list of cohorts that should be processed today based on the
 * UTC day-of-month.
 * @param {Date} [today=new Date()]
 * @returns {string[]} array of cohort keys (possibly empty)
 */
function getCohortsToProcessToday(today = new Date()) {
  const day = today.getUTCDate();
  if (day === 1) return [COHORT_FIRST];
  if (day === 15) return [COHORT_FIFTEENTH];
  return [];
}

/**
 * Decide whether a group is *eligible* for a given cohort run.
 *
 * FIRST: every group is eligible. Every group can have 1st-of-month households
 *   (the validators allow day=1 regardless of the mid-month flag).
 *
 * FIFTEENTH: a group is eligible if either:
 *   (a) `AllowMidMonthEffective` is on (so new 15th-of-month enrollments are
 *       being accepted), OR
 *   (b) the group has an existing active FIFTEENTH plan row (`HasFifteenthPlan`).
 *       This covers the toggle-off-mid-stream case: a tenant flips the flag
 *       off but legacy 15th-cohort households still have active enrollments
 *       and need their plan refreshed each cycle (otherwise their DIME
 *       schedule goes stale or their billing stops cold).
 *
 * Eligibility ≠ "will be billed". The actual scheduler skips any (group, cohort)
 * pair whose cohort-filtered premium total is $0 *and* whose plan row for that
 * cohort doesn't exist yet. If premium is $0 and a plan exists, the
 * cohort-emptied branch in processGroupForCohort cancels the DIME schedule and
 * deactivates the plan.
 *
 * @param {{ AllowMidMonthEffective?: boolean | 0 | 1, HasFifteenthPlan?: boolean | 0 | 1 }} group
 * @param {string} cohort - 'FIRST' or 'FIFTEENTH'
 * @returns {boolean}
 */
function shouldGroupProcessForCohort(group, cohort) {
  if (cohort === COHORT_FIRST) return true;
  const isMidMonth = group?.AllowMidMonthEffective === true || group?.AllowMidMonthEffective === 1;
  if (isMidMonth) return true;
  // Toggle-off-mid-stream safeguard: keep refreshing the existing FIFTEENTH plan
  // (or empty it out cleanly via the cohort-emptied branch) even after the flag flips off.
  return group?.HasFifteenthPlan === true || group?.HasFifteenthPlan === 1;
}

/**
 * Process a single group for a given cohort: verify DIME customer, cancel
 * existing schedules, create a fresh recurring payment schedule, and persist
 * the new plan record. Mutates the shared `results` accumulator.
 *
 * @param {Object} group - group row from the cohort SELECT
 * @param {string} cohort - cohort key
 * @param {Date} today - UTC "now" anchor for date math
 * @param {Object} results - shared counters {processed, updated, unchanged, failed, errors}
 * @param {Object} pool - mssql connection pool
 */
async function processGroupForCohort(group, cohort, today, results, pool) {
  const billingDay = getChargeDayForCohort(cohort);
  const cohortStartDay = cohort === COHORT_FIRST ? 1 : 15;
  const billingDate = new Date(Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    cohortStartDay
  ));

  try {
    console.log(`\n🏢 Processing group: ${group.GroupName} (${group.GroupId}) — cohort ${cohort}`);
    console.log(`  📅 Billing Date: ${billingDate.toISOString().split('T')[0]} (charge day: ${billingDay})`);

    // Look up the existing plan for THIS cohort only. A mixed-cohort group can have
    // two active plans (one FIRST, one FIFTEENTH), each with its own DIME schedule.
    // Touching only the cohort-matching plan is what makes mixed-cohort billing safe.
    const existingPlanResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, group.GroupId)
      .input('cohort', sql.NVarChar(20), cohort)
      .query(`
        SELECT TOP 1 PlanId, DimeScheduleId, MonthlyAmount, NextBillingDate
        FROM oe.GroupRecurringPaymentPlans
        WHERE GroupId = @groupId AND Cohort = @cohort AND IsActive = 1
        ORDER BY CreatedDate DESC
      `);
    const existingPlan = existingPlanResult.recordset[0] || null;
    const currentAmount = existingPlan ? Number(existingPlan.MonthlyAmount || 0) : 0;
    const currentScheduleId = existingPlan?.DimeScheduleId || null;

    // Calculate cohort-filtered total premium. The SP filters to enrollments whose
    // EffectiveDate matches this cohort (day=15 for FIFTEENTH, day≠15 for FIRST so
    // legacy non-cohort dates stay on FIRST).
    const premiumResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, group.GroupId)
      .input('billingDate', sql.DateTime2, billingDate)
      .input('cohort', sql.NVarChar(20), cohort)
      .execute('oe.sp_CalculateGroupTotalPremium');

    const newAmount = premiumResult.recordset[0]?.TotalPremium || 0;
    const activeEnrollmentCount = premiumResult.recordset[0]?.ActiveEnrollmentCount || 0;

    console.log(`  📊 Calculated premium for ${cohort} cohort on ${billingDate.toISOString().split('T')[0]}: $${newAmount} (${activeEnrollmentCount} enrollments)`);
    console.log(`  📊 Current DIME amount for ${cohort}: $${currentAmount}${currentScheduleId ? ` (schedule ${currentScheduleId})` : ' (no plan yet)'}`);

    // Skip if no premium AND no existing plan — this cohort has no work to do.
    if (newAmount === 0 && !existingPlan) {
      console.log(`  ⏭️  No ${cohort}-cohort enrollments and no existing plan; skipping.`);
      return;
    }

    results.processed++;

    // Empty cohort: cancel the existing schedule and deactivate the plan.
    // This handles the "all 15th-cohort households left the group" case.
    //
    // Money safety: only deactivate the plan row AFTER the DIME cancel confirms.
    // If we deactivate the row first and the cancel later fails, the plan row
    // says "no plan" but DIME keeps charging — a silent perpetual-charge bug.
    if (newAmount === 0 && existingPlan) {
      console.log(`  🧹 ${cohort} cohort emptied out — canceling schedule and deactivating plan.`);
      if (currentScheduleId) {
        let cancelResp;
        try {
          cancelResp = await DimeService.cancelRecurringPayment(currentScheduleId, group.TenantId);
        } catch (e) {
          console.error(`  ❌ Error canceling empty-cohort DIME schedule ${currentScheduleId}: ${e.message}`);
          results.failed++;
          results.errors.push({
            groupId: group.GroupId,
            groupName: group.GroupName,
            cohort,
            error: `Failed to cancel empty-cohort DIME schedule ${currentScheduleId}: ${e.message}. Plan left active so the next run can retry.`,
          });
          return;
        }
        if (!cancelResp?.success) {
          console.error(`  ❌ DIME refused to cancel empty-cohort schedule ${currentScheduleId}: ${cancelResp?.error}`);
          results.failed++;
          results.errors.push({
            groupId: group.GroupId,
            groupName: group.GroupName,
            cohort,
            error: `DIME refused to cancel empty-cohort schedule ${currentScheduleId}: ${cancelResp?.error}. Plan left active so the next run can retry.`,
          });
          return;
        }
        console.log(`  ✅ Canceled DIME schedule ${currentScheduleId}${cancelResp.wasAlreadyCanceled ? ' (was already canceled at DIME)' : ''}`);
      }
      await pool.request()
        .input('planId', sql.UniqueIdentifier, existingPlan.PlanId)
        .query(`
          UPDATE oe.GroupRecurringPaymentPlans
          SET IsActive = 0, ModifiedDate = GETUTCDATE()
          WHERE PlanId = @planId
        `);
      results.updated++;
      console.log(`  ✅ Deactivated empty-cohort plan ${existingPlan.PlanId}`);
      return;
    }

    if (newAmount === currentAmount) {
      console.log(`  ℹ️ Amount unchanged ($${newAmount}), still creating fresh schedule for next cycle`);
    } else {
      console.log(`  💰 Amount changed: $${currentAmount} → $${newAmount}`);
    }

    // Validate required DIME data
    if (!group.ProcessorCustomerId || !group.ProcessorPaymentMethodId) {
      console.warn(`  ⚠️ Missing DIME data for ${group.GroupName}, skipping update`);
      results.failed++;
      results.errors.push({
        groupId: group.GroupId,
        groupName: group.GroupName,
        cohort,
        error: 'Missing DIME customer or payment method'
      });
      return;
    }

    // Verify DIME customer exists (if not, create it)
    console.log(`  🔍 Verifying DIME customer exists: ${group.ProcessorCustomerId}`);
    try {
      const customerCheck = await DimeService.getCustomerByEmail(group.ContactEmail, group.TenantId);

      if (!customerCheck.success || !customerCheck.customerId) {
        console.log(`  ⚠️ DIME customer not found, creating new customer...`);

        if (!group.PrimaryContact || !group.ContactEmail) {
          console.error(`  ❌ Missing required group contact info for ${group.GroupName}`);
          results.failed++;
          results.errors.push({
            groupId: group.GroupId,
            groupName: group.GroupName,
            error: 'Missing PrimaryContact or ContactEmail - cannot create DIME customer'
          });
          return;
        }

        const contactParts = group.PrimaryContact.split(' ');
        const customerData = {
          firstName: contactParts[0],
          lastName: contactParts.slice(1).join(' ') || contactParts[0],
          email: group.ContactEmail,
          phone: group.ContactPhone?.replace(/\D/g, '').slice(-10),
          billingAddress: '',
          billingCity: '',
          billingState: '',
          billingZip: '',
          billingCountry: 'US'
        };

        const createResult = await DimeService.createCustomer(customerData, group.TenantId);

        if (createResult.success) {
          console.log(`  ✅ Created DIME customer: ${createResult.customerId}`);

          await pool.request()
            .input('groupId', sql.UniqueIdentifier, group.GroupId)
            .input('customerId', sql.NVarChar(255), createResult.customerId)
            .query(`
              UPDATE oe.Groups
              SET ProcessorCustomerId = @customerId, ModifiedDate = GETUTCDATE()
              WHERE GroupId = @groupId
            `);

          group.ProcessorCustomerId = createResult.customerId;
        } else {
          console.error(`  ❌ Failed to create DIME customer: ${createResult.message}`);
          results.failed++;
          results.errors.push({
            groupId: group.GroupId,
            groupName: group.GroupName,
            error: `Failed to create DIME customer: ${createResult.message}`
          });
          return;
        }
      } else {
        console.log(`  ✅ DIME customer verified: ${customerCheck.customerId}`);

        if (customerCheck.customerId !== group.ProcessorCustomerId) {
          console.log(`  🔄 Updating database with correct customer ID: ${customerCheck.customerId}`);
          await pool.request()
            .input('groupId', sql.UniqueIdentifier, group.GroupId)
            .input('customerId', sql.NVarChar(255), customerCheck.customerId)
            .query(`
              UPDATE oe.Groups
              SET ProcessorCustomerId = @customerId, ModifiedDate = GETUTCDATE()
              WHERE GroupId = @groupId
            `);

          group.ProcessorCustomerId = customerCheck.customerId;
        }
      }
    } catch (error) {
      console.warn(`  ⚠️ Error verifying DIME customer:`, error.message);
      // Continue anyway - might work
    }

    // Calculate next billing (charge) date for this cohort:
    // the configured charge day in `today`'s UTC month if still future,
    // otherwise that charge day in next UTC month.
    let nextBillingDate = new Date(Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      billingDay
    ));
    if (nextBillingDate <= today) {
      nextBillingDate = new Date(Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth() + 1,
        billingDay
      ));
    }

    console.log(`  📅 Next billing date: ${nextBillingDate.toISOString().split('T')[0]}`);

    // Cancel only the EXISTING schedule for THIS cohort (a sibling cohort's plan is
    // independent and must be left alone). Stale rows from prior runs of the same
    // cohort are deactivated below alongside the insert.
    //
    // Money safety: if DIME's cancel returns success=false (and not the benign
    // "already canceled / 404" case, which DimeService.cancelRecurringPayment maps
    // to success=true with wasAlreadyCanceled=true), the old schedule is still
    // ACTIVE on DIME's side and will charge on its next run. Creating a new
    // schedule on top would double-charge the customer next cycle. Bail loudly
    // instead — accounting investigates, and the next scheduler run retries.
    if (currentScheduleId) {
      let cancelResponse;
      try {
        cancelResponse = await DimeService.cancelRecurringPayment(currentScheduleId, group.TenantId);
      } catch (error) {
        console.error(`  ❌ Error canceling ${cohort}-cohort schedule ${currentScheduleId}:`, error.message);
        results.failed++;
        results.errors.push({
          groupId: group.GroupId,
          groupName: group.GroupName,
          cohort,
          error: `Failed to cancel prior DIME schedule ${currentScheduleId}: ${error.message}. Skipping new-schedule creation to avoid double-charge.`,
        });
        return;
      }
      if (cancelResponse?.success) {
        console.log(`  ✅ Canceled prior ${cohort}-cohort schedule ${currentScheduleId}${cancelResponse.wasAlreadyCanceled ? ' (was already canceled at DIME)' : ''}`);
      } else {
        console.error(`  ❌ DIME refused to cancel ${cohort}-cohort schedule ${currentScheduleId}: ${cancelResponse?.error}`);
        results.failed++;
        results.errors.push({
          groupId: group.GroupId,
          groupName: group.GroupName,
          cohort,
          error: `DIME refused to cancel prior schedule ${currentScheduleId}: ${cancelResponse?.error}. Skipping new-schedule creation to avoid double-charge.`,
        });
        return;
      }
    }

    // Create new recurring payment schedule
    const newSchedule = await DimeService.setupRecurringPayment({
      customerId: group.ProcessorCustomerId,
      paymentMethodId: group.ProcessorPaymentMethodId,
      amount: newAmount,
      description: `Group recurring payment for ${group.GroupName}`,
      startDate: nextBillingDate
    }, group.TenantId);

    if (newSchedule.success) {
      console.log(`  ✅ Created new schedule ${newSchedule.scheduleId} with amount $${newAmount}`);

      // Deactivate only OLD schedules for THIS cohort (the sibling cohort's plan must
      // stay active). The unique index UX_GroupRecurringPaymentPlans_GroupId_Cohort_Active
      // would otherwise reject the insert below.
      await pool.request()
        .input('groupId', sql.UniqueIdentifier, group.GroupId)
        .input('cohort', sql.NVarChar(20), cohort)
        .query(`
          UPDATE oe.GroupRecurringPaymentPlans
          SET IsActive = 0, ModifiedDate = GETUTCDATE()
          WHERE GroupId = @groupId AND Cohort = @cohort AND IsActive = 1
        `);

      console.log(`  ✅ Deactivated prior ${cohort}-cohort plan rows`);

      // Insert new plan row tagged with this cohort.
      await pool.request()
        .input('groupId', sql.UniqueIdentifier, group.GroupId)
        .input('newScheduleId', sql.NVarChar(255), newSchedule.scheduleId)
        .input('newAmount', sql.Decimal(10, 2), newAmount)
        .input('billingDay', sql.Int, billingDay)
        .input('nextBillingDate', sql.DateTime2, nextBillingDate)
        .input('cohort', sql.NVarChar(20), cohort)
        .query(`
          INSERT INTO oe.GroupRecurringPaymentPlans (
            PlanId, GroupId, DimeScheduleId, MonthlyAmount, BillingDay,
            NextBillingDate, IsActive, Cohort, CreatedDate, ModifiedDate
          ) VALUES (
            NEWID(), @groupId, @newScheduleId, @newAmount, @billingDay,
            @nextBillingDate, 1, @cohort, GETUTCDATE(), GETUTCDATE()
          )
        `);

      if (currentAmount === newAmount) {
        console.log(`  ✅ Renewed ${group.GroupName} ${cohort}: $${newAmount} (Schedule: ${currentScheduleId || '(new)'} → ${newSchedule.scheduleId})`);
        results.unchanged++;
      } else {
        console.log(`  ✅ Updated ${group.GroupName} ${cohort}: $${currentAmount} → $${newAmount} (Schedule: ${currentScheduleId || '(new)'} → ${newSchedule.scheduleId})`);
        results.updated++;
      }
    } else {
      console.error(`  ❌ Failed to create new schedule for ${group.GroupName}:`, newSchedule.message);
      results.failed++;
      results.errors.push({
        groupId: group.GroupId,
        groupName: group.GroupName,
        error: newSchedule.message
      });
    }
  } catch (error) {
    console.error(`  ❌ Error processing ${group.GroupName}:`, error);
    results.failed++;
    results.errors.push({
      groupId: group.GroupId,
      groupName: group.GroupName,
      error: error.message
    });
  }
}

/**
 * Calculate and update recurring payment amounts for all active groups for
 * whichever cohort(s) are due today (FIRST on day 1, FIFTEENTH on day 15).
 * @returns {Promise<Object>} Results summary
 */
async function calculateMonthlyRecurringPayments() {
  const pool = await getPool();
  const results = {
    processed: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    errors: []
  };

  try {
    const today = new Date();
    console.log('📅 Starting monthly recurring payment calculation for all groups...');
    console.log(`🗓️ Calculation Date: ${today.toISOString()}`);

    const cohorts = getCohortsToProcessToday(today);
    if (cohorts.length === 0) {
      console.log('ℹ️ Not a billing day (expected UTC day 1 or 15); exiting.');
      return results;
    }
    console.log(`🎯 Cohorts to process today: ${cohorts.join(', ')}`);

    // Get every active group that has at least one recurring plan or could need one.
    // We don't join GroupRecurringPaymentPlans here because a mid-month group may not
    // have a FIFTEENTH plan yet on its first 15th-cycle run; we look up each cohort's
    // plan inside processGroupForCohort.
    const groupsQuery = `
      SELECT DISTINCT
        g.GroupId,
        g.Name as GroupName,
        g.TenantId,
        g.PrimaryContact,
        g.ContactEmail,
        g.ContactPhone,
        g.ProcessorCustomerId,
        g.AllowMidMonthEffective,
        gpm.ProcessorPaymentMethodId,
        CAST(CASE WHEN EXISTS (
          SELECT 1 FROM oe.GroupRecurringPaymentPlans grpF
          WHERE grpF.GroupId = g.GroupId
            AND grpF.IsActive = 1
            AND grpF.Cohort = 'FIFTEENTH'
        ) THEN 1 ELSE 0 END AS bit) AS HasFifteenthPlan
      FROM oe.Groups g
      LEFT JOIN oe.GroupPaymentMethods gpm ON g.GroupId = gpm.GroupId
        AND gpm.IsDefault = 1 AND gpm.Status = 'Active'
      WHERE g.Status = 'Active'
        AND EXISTS (
          SELECT 1 FROM oe.GroupRecurringPaymentPlans grp
          WHERE grp.GroupId = g.GroupId AND grp.IsActive = 1
        )
      ORDER BY g.Name
    `;

    const groupsResult = await pool.request().query(groupsQuery);
    const groups = groupsResult.recordset;

    console.log(`📊 Found ${groups.length} active groups with recurring payment plans`);

    // For each cohort, run every eligible group through processGroupForCohort. A group
    // can match BOTH cohorts (mixed-cohort billing): the FIRST cohort scheduler bills
    // its 1st-of-month households on day 5, the FIFTEENTH cohort scheduler bills its
    // 15th-of-month households on day 20. Each (group, cohort) pair has its own plan
    // row + DIME schedule, so neither cycle disturbs the other.
    for (const cohort of cohorts) {
      const groupsForCohort = groups.filter((g) => shouldGroupProcessForCohort(g, cohort));

      console.log(`\n🎯 Cohort ${cohort}: ${groupsForCohort.length} group(s) eligible`);

      for (const group of groupsForCohort) {
        await processGroupForCohort(group, cohort, today, results, pool);
      }
    }

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('📊 Monthly Recurring Payment Calculation Summary');
    console.log('='.repeat(80));
    console.log(`✅ Processed: ${results.processed} groups`);
    console.log(`✅ Updated: ${results.updated} groups`);
    console.log(`ℹ️ Unchanged: ${results.unchanged} groups`);
    console.log(`❌ Failed: ${results.failed} groups`);

    if (results.errors.length > 0) {
      console.log('\n❌ Errors:');
      results.errors.forEach(err => {
        console.log(`  - ${err.groupName}: ${err.error}`);
      });
    }

    return results;

  } catch (error) {
    console.error('❌ Monthly calculation failed:', error);
    throw error;
  }
}

/**
 * Check if today is the 1st of the month (FIRST cohort billing day).
 * Kept for backward compatibility with existing callers/tests.
 * @returns {boolean}
 */
function isFirstOfMonth() {
  const today = new Date();
  return today.getDate() === 1;
}

/**
 * Run the monthly calculation if today is a cohort billing day.
 * This can be called from a scheduled job or cron.
 * @returns {Promise<Object|null>} Results or null if not a billing day.
 */
async function runMonthlyCalculationIfDue() {
  const cohorts = getCohortsToProcessToday(new Date());
  if (cohorts.length === 0) {
    console.log('ℹ️ Not a cohort billing day (UTC day 1 or 15), skipping monthly calculation');
    return null;
  }

  console.log(`🗓️ Cohort billing day — running monthly calculation for: ${cohorts.join(', ')}`);
  return await calculateMonthlyRecurringPayments();
}

module.exports = {
  calculateMonthlyRecurringPayments,
  runMonthlyCalculationIfDue,
  isFirstOfMonth,
  getCohortsToProcessToday,
  shouldGroupProcessForCohort,
  processGroupForCohort
};
