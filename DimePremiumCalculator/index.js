const { getPool, sql } = require('../shared/db');
const { createLogger } = require('../shared/logger');

/**
 * Daily Premium Updater
 * Runs daily at 2 AM
 * 
 * Updates MonthlyAmount in GroupRecurringPaymentPlans based on current enrollments
 * Does NOT interact with DIME - only updates the database
 * 
 * MULTI-LOCATION BILLING:
 * See docs/group-payments/MULTI_LOCATION_BILLING.md for full implementation details
 * 
 * TODO: Update to use sp_CalculateLocationPremiums for location-based billing
 * - Calculate premiums per-location (not just group total)
 * - Store location-specific amounts for separate invoicing
 * - Support fallback logic when members have no LocationId
 */
module.exports = async function (context, myTimer) {
  const logger = createLogger(context);
  const startTime = new Date();
  
  logger.section('Daily Premium Updater Started');
  logger.info(`Execution Date: ${startTime.toISOString()}`);
  
  let pool;
  const results = {
    processed: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    errors: []
  };

  try {
    // Connect to database
    pool = await getPool();
    logger.success('Database connected');
    
    // Calculate the billing date for next billing cycle
    // If we're past the 5th, calculate for next month
    // If before the 5th, calculate for this month
    const today = new Date();
    const currentDay = today.getDate();
    
    let billingDate;
    if (currentDay >= 5) {
      // Past the 5th, so calculate for next month's billing
      billingDate = new Date(today.getFullYear(), today.getMonth() + 1, 5);
    } else {
      // Before the 5th, so calculate for this month's billing
      billingDate = new Date(today.getFullYear(), today.getMonth(), 5);
    }
    
    logger.info(`Billing Date (Next Cycle): ${billingDate.toISOString().split('T')[0]}`);
    
    // Get all active groups with recurring payment plans
    const groupsQuery = `
      SELECT DISTINCT
        g.GroupId,
        g.Name as GroupName,
        g.TenantId,
        grp.PlanId,
        grp.MonthlyAmount as CurrentAmount,
        grp.IsActive
      FROM oe.Groups g
      INNER JOIN oe.GroupRecurringPaymentPlans grp ON g.GroupId = grp.GroupId
      WHERE g.Status = 'Active'
        AND grp.IsActive = 1
      ORDER BY g.Name
    `;
    
    const groupsResult = await pool.request().query(groupsQuery);
    const groups = groupsResult.recordset;
    
    logger.info(`Found ${groups.length} active groups with recurring payment plans`);
    
    // Process each group
    for (const group of groups) {
      results.processed++;
      
      try {
        logger.subsection(`Processing: ${group.GroupName} (${group.GroupId})`);
        
        // Calculate total premium for the group
        const premiumResult = await pool.request()
          .input('groupId', sql.UniqueIdentifier, group.GroupId)
          .input('billingDate', sql.DateTime2, billingDate)
          .execute('oe.sp_CalculateGroupTotalPremium');
        
        const newAmount = premiumResult.recordset[0]?.TotalPremium || 0;
        const activeEnrollmentCount = premiumResult.recordset[0]?.ActiveEnrollmentCount || 0;
        
        logger.info(`  Calculated: $${newAmount} (${activeEnrollmentCount} enrollments)`);
        logger.info(`  Current: $${group.CurrentAmount}`);
        
        // Check if amount changed
        const amountChanged = Math.abs(parseFloat(newAmount) - parseFloat(group.CurrentAmount)) > 0.01;
        
        if (amountChanged) {
          // Update the MonthlyAmount in GroupRecurringPaymentPlans
          await pool.request()
            .input('planId', sql.UniqueIdentifier, group.PlanId)
            .input('newAmount', sql.Decimal(10,2), newAmount)
            .query(`
              UPDATE oe.GroupRecurringPaymentPlans
              SET MonthlyAmount = @newAmount,
                  ModifiedDate = GETUTCDATE()
              WHERE PlanId = @planId
            `);
          
          logger.success(`  Updated: $${group.CurrentAmount} → $${newAmount}`);
          results.updated++;
        } else {
          logger.info(`  No change: $${newAmount}`);
          results.unchanged++;
        }
        
      } catch (error) {
        logger.error(`  Error: ${error.message}`);
        results.failed++;
        results.errors.push({
          groupId: group.GroupId,
          groupName: group.GroupName,
          error: error.message
        });
      }
    }
    
    // Summary
    logger.section('Daily Premium Updater Summary');
    logger.info(`Processed: ${results.processed} groups`);
    logger.success(`Updated: ${results.updated} groups`);
    logger.info(`Unchanged: ${results.unchanged} groups`);
    logger.error(`Failed: ${results.failed} groups`);
    
    if (results.errors.length > 0) {
      logger.subsection('Errors');
      results.errors.forEach(err => {
        logger.error(`  ${err.groupName}: ${err.error}`);
      });
    }
    
    const duration = (new Date() - startTime) / 1000;
    logger.success(`Completed in ${duration.toFixed(2)}s`);
    
    // Store execution log
    await pool.request()
      .input('jobName', sql.NVarChar(100), 'DailyPremiumUpdater')
      .input('startTime', sql.DateTime2, startTime)
      .input('endTime', sql.DateTime2, new Date())
      .input('status', sql.NVarChar(50), results.failed === 0 ? 'Success' : 'PartialSuccess')
      .input('resultSummary', sql.NVarChar(sql.MAX), JSON.stringify(results))
      .query(`
        INSERT INTO oe.ScheduledJobExecutions (
          ExecutionId, JobName, StartTime, EndTime, Status, ResultSummary
        ) VALUES (
          NEWID(), @jobName, @startTime, @endTime, @status, @resultSummary
        )
      `);
    
  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    logger.error(`Stack: ${error.stack}`);
    
    // Store error log
    if (pool) {
      try {
        await pool.request()
          .input('jobName', sql.NVarChar(100), 'DailyPremiumUpdater')
          .input('startTime', sql.DateTime2, startTime)
          .input('endTime', sql.DateTime2, new Date())
          .input('status', sql.NVarChar(50), 'Failed')
          .input('errorMessage', sql.NVarChar(sql.MAX), error.message)
          .query(`
            INSERT INTO oe.ScheduledJobExecutions (
              ExecutionId, JobName, StartTime, EndTime, Status, ErrorMessage
            ) VALUES (
              NEWID(), @jobName, @startTime, @endTime, @status, @errorMessage
            )
          `);
      } catch (logError) {
        logger.error(`Failed to log error: ${logError.message}`);
      }
    }
    
    throw error;
  } finally {
    if (pool) {
      try {
        await pool.close();
        logger.info('Database connection closed');
      } catch (closeError) {
        logger.error(`Error closing connection: ${closeError.message}`);
      }
    }
  }
};

