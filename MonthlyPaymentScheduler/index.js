const { getPool, sql } = require('../shared/db');
const DimeService = require('../shared/dimeService');
const { createLogger } = require('../shared/logger');
const fs = require('fs');
const path = require('path');

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
    emailsSent: 0,
    emailsFailed: 0,
    errors: []
  };

  try {
    // Connect to database
    pool = await getPool();
    logger.success('Database connected');
    
    // Calculate the billing date (5th of next billing cycle)
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
    
    // Get all active groups (with or without recurring payment plans)
    // This will create plans for new groups and update existing ones
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
        grp.IsActive as PlanIsActive,
        gpm.ProcessorPaymentMethodId
      FROM oe.Groups g
      LEFT JOIN oe.GroupRecurringPaymentPlans grp ON g.GroupId = grp.GroupId AND grp.IsActive = 1
      LEFT JOIN oe.GroupPaymentMethods gpm ON g.GroupId = gpm.GroupId 
        AND gpm.IsDefault = 1 AND gpm.Status = 'Active'
      WHERE g.Status = 'Active'
      ORDER BY g.Name
    `;
    
    const groupsResult = await pool.request().query(groupsQuery);
    const groups = groupsResult.recordset;
    
    logger.info(`Found ${groups.length} active groups (will create/update payment plans)`);
    
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
        logger.info(`  Current: $${group.CurrentAmount || 'No plan yet'}`);
        
        // Skip groups with no enrollments
        if (newAmount === 0 || activeEnrollmentCount === 0) {
          logger.warn(`  No active enrollments, skipping`);
          continue;
        }
        
        // If no payment plan exists, we'll create it AFTER creating the DIME schedule
        // This avoids NULL constraint issues with DimeScheduleId
        const needsNewPlan = !group.PlanId;
        
        // Validate DIME data
        if (!group.ProcessorCustomerId || !group.ProcessorPaymentMethodId) {
          logger.warn(`  Missing DIME data, skipping DIME schedule creation`);
          logger.info(`  Payment plan created in database, but needs DIME setup`);
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
          
          // Insert new schedule record (now with DIME schedule ID)
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
          
          if (needsNewPlan) {
            logger.success(`  Created new payment plan with $${newAmount}`);
            results.updated++;
          } else if (group.CurrentAmount === newAmount) {
            logger.success(`  Renewed: $${newAmount}`);
            results.unchanged++;
          } else {
            logger.success(`  Updated: $${group.CurrentAmount} → $${newAmount}`);
            results.updated++;
          }
          
          // Send invoice email
          try {
            logger.info(`  Sending invoice email...`);
            
            // Get enrollment details for the invoice
            const enrollmentsQuery = `
              SELECT 
                m.FirstName + ' ' + m.LastName as MemberName,
                p.Name as ProductName,
                e.PremiumAmount
              FROM oe.Enrollments e
              INNER JOIN oe.Members m ON e.MemberId = m.MemberId
              INNER JOIN oe.Products p ON e.ProductId = p.ProductId
              WHERE e.GroupId = @groupId
                AND e.Status = 'Active'
                AND e.EffectiveDate <= @billingDate
                AND (e.TerminationDate IS NULL OR e.TerminationDate > @billingDate)
              ORDER BY m.LastName, m.FirstName
            `;
            
            const enrollmentsResult = await pool.request()
              .input('groupId', sql.UniqueIdentifier, group.GroupId)
              .input('billingDate', sql.DateTime2, billingDate)
              .query(enrollmentsQuery);
            
            // Build enrollment list HTML
            let enrollmentListHtml = '';
            if (enrollmentsResult.recordset.length > 0) {
              enrollmentsResult.recordset.forEach(enrollment => {
                enrollmentListHtml += `
                  <tr>
                    <td style="padding:12px;border-bottom:1px solid #e9ecef;font-size:14px;color:#333333;">
                      ${enrollment.MemberName}
                    </td>
                    <td style="padding:12px;border-bottom:1px solid #e9ecef;font-size:14px;color:#333333;">
                      ${enrollment.ProductName}
                    </td>
                    <td style="padding:12px;border-bottom:1px solid #e9ecef;font-size:14px;color:#333333;text-align:right;">
                      $${parseFloat(enrollment.PremiumAmount).toFixed(2)}
                    </td>
                  </tr>
                `;
              });
            } else {
              enrollmentListHtml = `
                <tr>
                  <td colspan="3" style="padding:12px;text-align:center;color:#666666;font-size:14px;">
                    No detailed enrollment information available
                  </td>
                </tr>
              `;
            }
            
            // Get tenant info
            const tenantQuery = `
              SELECT TenantId FROM oe.Groups WHERE GroupId = @groupId
            `;
            const tenantResult = await pool.request()
              .input('groupId', sql.UniqueIdentifier, group.GroupId)
              .query(tenantQuery);
            const tenantId = tenantResult.recordset[0]?.TenantId;
            
            // Load and process email template
            const templatePath = path.join(__dirname, '..', '..', 'backend', 'templates', 'emails', 'monthly-invoice.html');
            let emailHtml = fs.readFileSync(templatePath, 'utf8');
            
            // Format dates and currency
            const formatDate = (date) => new Date(date).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric'
            });
            
            // Replace template variables
            const variables = {
              groupName: group.GroupName,
              contactName: group.PrimaryContact.split(' ')[0],
              totalAmount: `$${parseFloat(newAmount).toFixed(2)}`,
              enrollmentCount: activeEnrollmentCount.toString(),
              billingDate: formatDate(billingDate),
              nextBillingDate: formatDate(nextBillingDate),
              currentYear: new Date().getFullYear().toString(),
              enrollmentList: enrollmentListHtml
            };
            
            // Simple template processing
            Object.keys(variables).forEach(key => {
              const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
              emailHtml = emailHtml.replace(regex, variables[key] || '');
            });
            
            // Handle conditional blocks for enrollmentList
            if (enrollmentListHtml) {
              emailHtml = emailHtml.replace(/\{\{#enrollmentList\}\}([\s\S]*?)\{\{\/enrollmentList\}\}/g, '$1');
            } else {
              emailHtml = emailHtml.replace(/\{\{#enrollmentList\}\}[\s\S]*?\{\{\/enrollmentList\}\}/g, '');
            }
            
            // Queue email in MessageQueue
            const messageId = require('crypto').randomUUID();
            await pool.request()
              .input('messageId', sql.UniqueIdentifier, messageId)
              .input('tenantId', sql.UniqueIdentifier, tenantId)
              .input('recipientAddress', sql.NVarChar, group.ContactEmail)
              .input('subject', sql.NVarChar, `Monthly Benefits Invoice - ${group.GroupName}`)
              .input('body', sql.NVarChar, emailHtml)
              .query(`
                INSERT INTO oe.MessageQueue (
                  MessageId, TenantId, MessageType, RecipientAddress, 
                  Subject, Body, Status, RetryCount, CreatedDate, CreatedBy
                ) VALUES (
                  @messageId, @tenantId, 'Email', @recipientAddress,
                  @subject, @body, 'Pending', 0, GETUTCDATE(), 
                  '00000000-0000-0000-0000-000000000000'
                )
              `);
            
            logger.success(`  Invoice email queued: ${messageId}`);
            results.emailsSent++;
          } catch (emailError) {
            logger.error(`  Failed to send invoice email: ${emailError.message}`);
            results.emailsFailed++;
            // Don't fail the whole process if email fails
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
    logger.success(`Emails Sent: ${results.emailsSent}`);
    logger.error(`Emails Failed: ${results.emailsFailed}`);
    
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

