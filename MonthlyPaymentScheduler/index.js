const { getPool, sql } = require('../shared/db');
const DimeService = require('../shared/dimeService');
const { createLogger } = require('../shared/logger');

/**
 * Monthly Payment Scheduler
 * Runs on the 1st of each month at 6 AM
 * 
 * Calculates and updates recurring payment amounts for all active groups
 */
module.exports = async function (context, myTimer) {
  const logger = createLogger(context);
  const startTime = new Date();
  
  logger.section('Monthly Payment Scheduler Started');
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
    
    // Calculate the billing date (5th of this month)
    const today = new Date();
    const billingDate = new Date(today.getFullYear(), today.getMonth(), 5);
    logger.info(`Billing Date: ${billingDate.toISOString().split('T')[0]}`);
    
    // Get all active groups with recurring payment plans
    const groupsQuery = `
      SELECT DISTINCT
        g.GroupId,
        g.Name as GroupName,
        g.PrimaryContact,
        g.ContactEmail,
        g.ContactPhone,
        g.ProcessorCustomerId,
        grp.PlanId,
        grp.DimeScheduleId,
        grp.MonthlyAmount as CurrentAmount,
        grp.NextBillingDate,
        gpm.ProcessorPaymentMethodId
      FROM oe.Groups g
      INNER JOIN oe.GroupRecurringPaymentPlans grp ON g.GroupId = grp.GroupId
      LEFT JOIN oe.GroupPaymentMethods gpm ON g.GroupId = gpm.GroupId 
        AND gpm.IsDefault = 1 AND gpm.Status = 'Active'
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
        
        // Calculate total premium for billing date (5th)
        const premiumResult = await pool.request()
          .input('groupId', sql.UniqueIdentifier, group.GroupId)
          .input('billingDate', sql.DateTime2, billingDate)
          .execute('oe.sp_CalculateGroupTotalPremium');
        
        const newAmount = premiumResult.recordset[0]?.TotalPremium || 0;
        const activeEnrollmentCount = premiumResult.recordset[0]?.ActiveEnrollmentCount || 0;
        
        logger.info(`  Calculated: $${newAmount} (${activeEnrollmentCount} enrollments)`);
        logger.info(`  Current: $${group.CurrentAmount}`);
        
        // Validate DIME data
        if (!group.ProcessorCustomerId || !group.ProcessorPaymentMethodId) {
          logger.warn(`  Missing DIME data, skipping`);
          results.failed++;
          results.errors.push({
            groupId: group.GroupId,
            groupName: group.GroupName,
            error: 'Missing DIME customer or payment method'
          });
          continue;
        }
        
        // Verify DIME customer exists
        const customerCheck = await DimeService.getCustomerByEmail(group.ContactEmail);
        if (!customerCheck.success) {
          logger.warn(`  DIME customer not found, attempting to create...`);
          
          if (!group.PrimaryContact || !group.ContactEmail) {
            logger.error(`  Missing contact info, cannot create customer`);
            results.failed++;
            results.errors.push({
              groupId: group.GroupId,
              groupName: group.GroupName,
              error: 'Missing contact information'
            });
            continue;
          }
          
          const contactParts = group.PrimaryContact.split(' ');
          const createResult = await DimeService.createCustomer({
            firstName: contactParts[0],
            lastName: contactParts.slice(1).join(' ') || contactParts[0],
            email: group.ContactEmail,
            phone: group.ContactPhone?.replace(/\D/g, '').slice(-10)
          });
          
          if (!createResult.success) {
            logger.error(`  Failed to create DIME customer: ${createResult.message}`);
            results.failed++;
            results.errors.push({
              groupId: group.GroupId,
              groupName: group.GroupName,
              error: `Failed to create DIME customer: ${createResult.message}`
            });
            continue;
          }
          
          logger.success(`  Created DIME customer: ${createResult.customerId}`);
          
          // Update database with customer ID
          await pool.request()
            .input('groupId', sql.UniqueIdentifier, group.GroupId)
            .input('customerId', sql.NVarChar(255), createResult.customerId)
            .query(`
              UPDATE oe.Groups 
              SET ProcessorCustomerId = @customerId, ModifiedDate = GETUTCDATE()
              WHERE GroupId = @groupId
            `);
          
          group.ProcessorCustomerId = createResult.customerId;
        }
        
        // Calculate next billing date
        const nextBillingDate = new Date(today.getFullYear(), today.getMonth() + 1, 5);
        logger.info(`  Next billing: ${nextBillingDate.toISOString().split('T')[0]}`);
        
        // Cancel ALL existing schedules for this group
        const allSchedulesQuery = `
          SELECT DimeScheduleId 
          FROM oe.GroupRecurringPaymentPlans 
          WHERE GroupId = @groupId
        `;
        const allSchedulesResult = await pool.request()
          .input('groupId', sql.UniqueIdentifier, group.GroupId)
          .query(allSchedulesQuery);
        
        const scheduleIds = allSchedulesResult.recordset.map(r => r.DimeScheduleId).filter(id => id);
        
        if (scheduleIds.length > 0) {
          logger.info(`  Canceling ${scheduleIds.length} existing schedule(s)`);
          
          for (const scheduleId of scheduleIds) {
            try {
              await DimeService.cancelRecurringPayment(scheduleId);
              logger.success(`    Canceled ${scheduleId}`);
            } catch (cancelError) {
              if (cancelError.response?.status !== 404) {
                logger.warn(`    Failed to cancel ${scheduleId}: ${cancelError.message}`);
              }
            }
          }
        }
        
        // Create new recurring payment schedule
        const newSchedule = await DimeService.setupRecurringPayment({
          customerId: group.ProcessorCustomerId,
          paymentMethodId: group.ProcessorPaymentMethodId,
          amount: newAmount,
          description: `Group recurring payment for ${group.GroupName}`,
          startDate: nextBillingDate
        });
        
        if (newSchedule.success) {
          logger.success(`  Created new schedule: ${newSchedule.scheduleId}`);
          
          // Delete ALL existing schedules for this group (cleaner than update)
          await pool.request()
            .input('groupId', sql.UniqueIdentifier, group.GroupId)
            .query(`
              DELETE FROM oe.GroupRecurringPaymentPlans 
              WHERE GroupId = @groupId
            `);
          
          // Insert new schedule record
          await pool.request()
            .input('groupId', sql.UniqueIdentifier, group.GroupId)
            .input('newScheduleId', sql.NVarChar(255), newSchedule.scheduleId)
            .input('newAmount', sql.Decimal(10,2), newAmount)
            .input('nextBillingDate', sql.DateTime2, nextBillingDate)
            .query(`
              INSERT INTO oe.GroupRecurringPaymentPlans (
                PlanId, GroupId, DimeScheduleId, MonthlyAmount, BillingDay,
                NextBillingDate, IsActive, CreatedDate, ModifiedDate
              ) VALUES (
                NEWID(), @groupId, @newScheduleId, @newAmount, 5,
                @nextBillingDate, 1, GETUTCDATE(), GETUTCDATE()
              )
            `);
          
          if (group.CurrentAmount === newAmount) {
            logger.success(`  Renewed: $${newAmount}`);
            results.unchanged++;
          } else {
            logger.success(`  Updated: $${group.CurrentAmount} → $${newAmount}`);
            results.updated++;
          }
        } else {
          logger.error(`  Failed to create schedule: ${newSchedule.error.message}`);
          results.failed++;
          results.errors.push({
            groupId: group.GroupId,
            groupName: group.GroupName,
            error: newSchedule.error.message
          });
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
    logger.section('Monthly Payment Scheduler Summary');
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
      .input('jobName', sql.NVarChar(100), 'MonthlyPaymentScheduler')
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
          .input('jobName', sql.NVarChar(100), 'MonthlyPaymentScheduler')
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

