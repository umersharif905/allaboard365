const { getPool, sql } = require('../shared/db');
const DimeService = require('../shared/dimeService');
const { createLogger } = require('../shared/logger');
const { createRecurringPaymentRecord, createFailedRecurringPaymentRecord, getPricingFields } = require('../shared/createRecurringPaymentRecord');

/**
 * DIME Payment Sync Function
 * Queries DIME API for transactions and syncs them to oe.Payments table
 * Only processes payments for customers we have in our database
 */
module.exports = async function (context, req) {
  const logger = createLogger(context);
  const startTime = new Date();
  
  logger.section('DIME Payment Sync Started');
  logger.info(`Execution Date: ${startTime.toISOString()}`);

  let pool;

  try {
    // Verify API key
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
      logger.warn('Unauthorized payment sync attempt');
      context.res = {
        status: 401,
        body: { success: false, error: 'Unauthorized' }
      };
      return;
    }

    // Parse time range from query params
    let startDate, endDate;
    const hours = parseInt(req.query?.hours) || 24;
    const startDateParam = req.query?.startDate;
    const endDateParam = req.query?.endDate;
    const dryRun = (req.query?.dryRun || req.query?.dry_run || '').toString().toLowerCase() === 'true' || req.query?.dryRun === '1';
    const maxPaymentsToCreate = parseInt(req.query?.limit || req.query?.maxPaymentsToCreate || '0', 10) || 0; // 0 = no limit

    if (startDateParam && endDateParam) {
      startDate = new Date(startDateParam);
      endDate = new Date(endDateParam);
    } else {
      // Default: look back specified hours
      endDate = new Date();
      startDate = new Date(endDate);
      startDate.setHours(startDate.getHours() - hours);
    }

    logger.info(`Time Range: ${startDate.toISOString()} to ${endDate.toISOString()}`);
    if (dryRun) logger.info('DRY RUN: no payments or invoices will be created/updated');
    if (maxPaymentsToCreate > 0) logger.info(`Limit: create at most ${maxPaymentsToCreate} new payment(s)`);

    // Format dates for DIME API (YYYY-MM-DD HH:mm:ss)
    const formatDateForDime = (date) => {
      return date.toISOString().replace('T', ' ').substring(0, 19);
    };

    const startDateFormatted = formatDateForDime(startDate);
    const endDateFormatted = formatDateForDime(endDate);

    // Connect to database
    pool = await getPool();
    logger.success('Database connected');

    // Statistics tracking
    const stats = {
      customersChecked: 0,
      customersWithTransactions: 0,
      totalTransactionsFound: 0,
      paymentsCreated: 0,
      paymentsUpdated: 0,
      paymentsSkipped: 0,
      failedFromListCreated: 0,
      failedFromListSkipped: 0,
      errors: [],
      dryRunWouldCreate: [],
      dryRunWouldUpdate: [],
      dryRunWouldCreateFailed: []
    };

    // Get all groups with ProcessorCustomerId, grouped by TenantId
    const groupsQuery = `
      SELECT 
        g.GroupId,
        g.TenantId,
        g.Name as GroupName,
        g.ProcessorCustomerId
      FROM oe.Groups g
      WHERE g.ProcessorCustomerId IS NOT NULL
        AND g.Status = 'Active'
      ORDER BY g.TenantId, g.Name
    `;

    const groupsResult = await pool.request().query(groupsQuery);
    const groups = groupsResult.recordset;

    logger.info(`Found ${groups.length} groups with ProcessorCustomerId`);

    if (groups.length === 0) {
      logger.warn('No groups with ProcessorCustomerId found');
      context.res = {
        status: 200,
        body: {
          success: true,
          message: 'No groups with ProcessorCustomerId found',
          stats,
          timestamp: new Date().toISOString()
        }
      };
      return;
    }

    // Group by TenantId to batch API calls
    const groupsByTenant = {};
    for (const group of groups) {
      if (!groupsByTenant[group.TenantId]) {
        groupsByTenant[group.TenantId] = [];
      }
      groupsByTenant[group.TenantId].push(group);
    }

    // Phase 2 only: groups that have an active recurring payment plan in our DB (so we only call DIME list for those).
    const groupsWithRecurringQuery = `
      SELECT DISTINCT
        g.GroupId,
        g.TenantId,
        g.Name as GroupName,
        g.ProcessorCustomerId
      FROM oe.Groups g
      INNER JOIN oe.GroupRecurringPaymentPlans grp ON grp.GroupId = g.GroupId
      WHERE g.ProcessorCustomerId IS NOT NULL
        AND g.Status = 'Active'
        AND grp.IsActive = 1
        AND grp.DimeScheduleId IS NOT NULL
      ORDER BY g.TenantId, g.Name
    `;
    const groupsWithRecurringResult = await pool.request().query(groupsWithRecurringQuery);
    const groupsWithRecurringByTenant = {};
    for (const row of groupsWithRecurringResult.recordset) {
      if (!groupsWithRecurringByTenant[row.TenantId]) {
        groupsWithRecurringByTenant[row.TenantId] = [];
      }
      groupsWithRecurringByTenant[row.TenantId].push(row);
    }
    const totalWithRecurring = groupsWithRecurringResult.recordset.length;
    logger.info(`Found ${totalWithRecurring} group(s) with active recurring payment plans (Phase 2 will query DIME only for these)`);

    logger.info(`Processing ${Object.keys(groupsByTenant).length} tenant(s)`);

    let reachedLimit = false;
    // Process each tenant: fetch recent transactions once per tenant (no per-customer filter), then match by customer_uuid
    for (const [tenantId, tenantGroups] of Object.entries(groupsByTenant)) {
      if (reachedLimit) break;
      stats.customersChecked += tenantGroups.length;
      logger.subsection(`Processing Tenant: ${tenantId} (${tenantGroups.length} groups)`);

      // Build map: customer_uuid -> group (so we can match each transaction to our group)
      const customerUuidToGroup = {};
      for (const g of tenantGroups) {
        const cu = (g.ProcessorCustomerId || '').toString().toLowerCase();
        if (cu) customerUuidToGroup[cu] = g;
      }

      let transactionsResult;
      try {
        // Query DIME for all recent transactions for this tenant (merchant-level); no customer_uuid filter
        transactionsResult = await DimeService.listRecentTransactions({
          start_date: startDateFormatted,
          end_date: endDateFormatted
        }, tenantId);
      } catch (apiError) {
        logger.warn(`  Failed to query DIME recent transactions: ${apiError.message}`);
        stats.errors.push({
          tenantId,
          error: apiError.message
        });
        continue;
      }

      if (!transactionsResult.success) {
        logger.warn(`  DIME recent transactions error: ${transactionsResult.error?.message || transactionsResult.message}`);
        stats.errors.push({
          tenantId,
          error: transactionsResult.error?.message || transactionsResult.message
        });
        continue;
      }

      const transactions = transactionsResult.transactions || [];
      if (transactions.length > 0) {
        stats.customersWithTransactions++;
        stats.totalTransactionsFound += transactions.length;
        logger.info(`  Found ${transactions.length} transaction(s) for tenant`);
      }

      // Process each transaction; match to our group by customer_uuid on the transaction
      // DIME API response: data[] with transaction_number, transaction_info_id, amount, transaction_status, transaction_type, customer_uuid, transaction_date/fund_date/settle_date
      for (const transaction of transactions) {
        try {
          // transaction_number can be empty in DIME response; use transaction_info_id as fallback for ProcessorTransactionId
          const transactionId = (transaction.transaction_number && String(transaction.transaction_number).trim()) 
            || transaction.transaction_info_id 
            || transaction.transaction_id 
            || transaction.id 
            || transaction.transactionNumber;
          const amount = parseFloat(transaction.amount) || 0;
          const statusCode = transaction.status_code;
          const statusText = transaction.status_text;
          const transactionStatus = transaction.transaction_status || ''; // e.g. "CC Pending", "CC Approved"
          const status = deriveTransactionStatus(statusCode, statusText, transactionStatus);
          const paymentMethod = normalizeDimeTransactionType(transaction.transaction_type || transaction.payment_method || transaction.paymentMethod);
          const scheduleId = transaction.schedule_id || transaction.recurring_payment_id || null;
          const customerUuidRaw = transaction.customer_uuid || transaction.customer_uuid_id || transaction.customer?.uuid || null;
          const customerUuid = customerUuidRaw ? String(customerUuidRaw).toLowerCase() : null;
          const transactionDate = transaction.transaction_date || transaction.fund_date || transaction.settle_date || transaction.date || transaction.created_at || new Date();

          if (!transactionId) {
            logger.warn(`  Skipping transaction without id: ${JSON.stringify(transaction).slice(0, 120)}`);
            stats.paymentsSkipped++;
            continue;
          }

          let group = customerUuid ? customerUuidToGroup[customerUuid] : null;

          // Fallback: if no group by customer_uuid, try to match by transaction ID to an existing payment (e.g. old DIME merchant data missing customer_uuid)
          if (!group && transactionId) {
            const existingByTxId = await pool.request()
              .input('processorTransactionId', sql.NVarChar(255), transactionId)
              .query(`
                SELECT PaymentId, Status, Amount
                FROM oe.Payments
                WHERE ProcessorTransactionId = @processorTransactionId
              `);
            if (existingByTxId.recordset.length === 1) {
              const existing = existingByTxId.recordset[0];
              const newStatus = mapDimeStatusToPaymentStatus(status, statusCode, statusText, transactionStatus);
              if (existing.Status !== newStatus && newStatus !== 'Unknown') {
                logger.info(`    [Fallback by tx id] Updating payment ${transactionId}: ${existing.Status} → ${newStatus}`);
                if (dryRun) {
                  stats.dryRunWouldUpdate.push({ processorTransactionId: transactionId, paymentId: existing.PaymentId, from: existing.Status, to: newStatus });
                  stats.paymentsUpdated++;
                } else {
                  await pool.request()
                    .input('paymentId', sql.UniqueIdentifier, existing.PaymentId)
                    .input('newStatus', sql.NVarChar(50), newStatus)
                    .query(`
                      UPDATE oe.Payments
                      SET Status = @newStatus,
                          ModifiedDate = GETUTCDATE()
                      WHERE PaymentId = @paymentId
                    `);
                  stats.paymentsUpdated++;
                  if (newStatus === 'Completed') {
                    await updateInvoiceIfNeeded(pool, existing.PaymentId, amount, logger);
                  }
                }
              } else {
                logger.info(`    [Fallback by tx id] Payment ${transactionId} already has status ${existing.Status}, skipping`);
                stats.paymentsSkipped++;
              }
              continue;
            }
            if (existingByTxId.recordset.length > 1) {
              logger.warn(`  Skipping transaction ${transactionId}: multiple payments share this ProcessorTransactionId (ambiguous)`);
              stats.paymentsSkipped++;
              continue;
            }
          }

          if (!group) {
            logger.info(`  Skipping transaction ${transactionId}: no group for customer_uuid ${customerUuidRaw || '(missing)'}`);
            stats.paymentsSkipped++;
            continue;
          }

          // Check if payment already exists
              const existingPayment = await pool.request()
                .input('processorTransactionId', sql.NVarChar(255), transactionId)
                .query(`
                  SELECT 
                    PaymentId,
                    Status,
                    Amount,
                    ProcessorTransactionId
                  FROM oe.Payments
                  WHERE ProcessorTransactionId = @processorTransactionId
                `);

              if (existingPayment.recordset.length > 0) {
                const existing = existingPayment.recordset[0];
                
                // Check if status needs updating
                const currentStatus = existing.Status;
                const newStatus = mapDimeStatusToPaymentStatus(status, statusCode, statusText, transactionStatus);

                if (currentStatus !== newStatus && newStatus !== 'Unknown') {
                  logger.info(`    Updating payment ${transactionId}: ${currentStatus} → ${newStatus}`);
                  if (dryRun) {
                    stats.dryRunWouldUpdate.push({ processorTransactionId: transactionId, paymentId: existing.PaymentId, from: currentStatus, to: newStatus });
                    stats.paymentsUpdated++;
                  } else {
                    await pool.request()
                      .input('paymentId', sql.UniqueIdentifier, existing.PaymentId)
                      .input('newStatus', sql.NVarChar(50), newStatus)
                      .query(`
                        UPDATE oe.Payments
                        SET Status = @newStatus,
                            ModifiedDate = GETUTCDATE()
                        WHERE PaymentId = @paymentId
                      `);
                    stats.paymentsUpdated++;
                    if (newStatus === 'Completed') {
                      await updateInvoiceIfNeeded(pool, existing.PaymentId, amount, logger);
                    }
                  }
                } else {
                  logger.info(`    Payment ${transactionId} already exists with status ${currentStatus}, skipping`);
                  stats.paymentsSkipped++;
                }
                continue;
              }

              // Payment doesn't exist - create it
              logger.info(`    Creating payment record for transaction ${transactionId}`);

              // Match transaction to group and find associated data
              // If no scheduleId, try to find it by customer_uuid
              let finalScheduleId = scheduleId;
              if (!finalScheduleId && (customerUuidRaw || customerUuid)) {
                try {
                  const scheduleResult = await pool.request()
                    .input('customerUuid', sql.NVarChar(255), customerUuidRaw || customerUuid)
                    .query(`
                      SELECT TOP 1 grp.DimeScheduleId
                      FROM oe.GroupRecurringPaymentPlans grp
                      INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
                      WHERE g.ProcessorCustomerId = @customerUuid
                        AND grp.IsActive = 1
                      ORDER BY grp.CreatedDate DESC
                    `);
                  
                  if (scheduleResult.recordset.length > 0) {
                    finalScheduleId = scheduleResult.recordset[0].DimeScheduleId;
                    logger.info(`    Found schedule_id ${finalScheduleId} for customer ${customerUuid}`);
                  }
                } catch (error) {
                  logger.warn(`    Could not find schedule_id for customer ${customerUuid}: ${error.message}`);
                }
              }
              
              const contextData = await matchTransactionToGroup(
                pool,
                group.GroupId,
                group.TenantId,
                finalScheduleId,
                logger
              );

              const paymentDate = transactionDate instanceof Date 
                ? transactionDate 
                : new Date(transactionDate);
              const paymentStatus = mapDimeStatusToPaymentStatus(status, statusCode, statusText, transactionStatus);

              // Same function as webhook: single source of truth for oe.Payments row
              if (dryRun) {
                const pricing = await getPricingFields(pool, contextData.groupId, contextData.householdId, logger);
                stats.dryRunWouldCreate.push({
                  processorTransactionId: transactionId,
                  amount,
                  paymentStatus,
                  paymentMethod,
                  paymentDate: paymentDate.toISOString(),
                  groupId: contextData.groupId,
                  tenantId: contextData.tenantId,
                  groupName: group.GroupName,
                  netRate: pricing.netRate,
                  commission: pricing.commission,
                  overrideRate: pricing.overrideRate,
                  systemFees: pricing.systemFees,
                  processingFeeAmount: pricing.processingFeeAmount ?? 0,
                  enrollmentId: contextData.enrollmentId,
                  agentId: contextData.agentId,
                  householdId: contextData.householdId,
                  locationId: contextData.locationId,
                  invoiceId: contextData.invoiceId,
                  wouldUpdateInvoice: !!(contextData.invoiceId && paymentStatus === 'Completed')
                });
                stats.paymentsCreated++;
                logger.info(`    [DRY RUN] Would create payment: ${transactionId} $${amount} ${group.GroupName}`);
                if (maxPaymentsToCreate > 0 && stats.paymentsCreated >= maxPaymentsToCreate) {
                  logger.info(`    [DRY RUN] Reached limit ${maxPaymentsToCreate}, stopping scan`);
                  reachedLimit = true;
                  break;
                }
              } else {
                if (maxPaymentsToCreate > 0 && stats.paymentsCreated >= maxPaymentsToCreate) {
                  logger.info(`    Skipping transaction ${transactionId} (already created ${stats.paymentsCreated}, limit ${maxPaymentsToCreate})`);
                  reachedLimit = true;
                  break;
                }
                await createRecurringPaymentRecord(pool, {
                  groupId: contextData.groupId,
                  tenantId: contextData.tenantId,
                  householdId: contextData.householdId,
                  enrollmentId: contextData.enrollmentId,
                  agentId: contextData.agentId,
                  locationId: contextData.locationId,
                  invoiceId: contextData.invoiceId,
                  scheduleId,
                  amount,
                  processorTransactionId: transactionId,
                  paymentDate,
                  paymentStatus,
                  paymentMethod,
                  nextBillingDate: null,
                  webhookEventId: null
                }, logger);
                stats.paymentsCreated++;
                logger.success(`    Created payment record for transaction ${transactionId}`);
                if (contextData.invoiceId && paymentStatus === 'Completed') {
                  await updateInvoiceIfNeeded(pool, null, amount, logger, contextData.invoiceId);
                }
                if (maxPaymentsToCreate > 0 && stats.paymentsCreated >= maxPaymentsToCreate) {
                  logger.info(`Reached limit ${maxPaymentsToCreate} new payment(s), stopping`);
                  reachedLimit = true;
                  break;
                }
              }

            } catch (transactionError) {
              logger.error(`  Error processing transaction ${transaction.transaction_number || transaction.transaction_id || transaction.id}: ${transactionError.message}`);
              stats.errors.push({
                groupId: group.GroupId,
                groupName: group.GroupName,
                transactionId: transaction.transaction_number || transaction.transaction_id || transaction.id,
                error: transactionError.message
              });
            }
          }

      // Phase 2: Failed recurring payments in date range (no transaction). Only for groups that have an active
      // recurring plan in our DB (oe.GroupRecurringPaymentPlans); avoids unnecessary DIME calls for groups with no schedule.
      const recurringGroupsForTenant = groupsWithRecurringByTenant[tenantId] || [];
      logger.subsection('Checking recurring-payment/list for failed runs in date range');
      for (const group of recurringGroupsForTenant) {
        if (reachedLimit) break;
        const customerId = (group.ProcessorCustomerId || '').toString();
        if (!customerId) continue;
        logger.info(`  Querying recurring-payment/list for group "${group.GroupName}" (customer_uuid: ${customerId})`);
        let listResult;
        try {
          // Request only Failed schedules; if DIME rejects filters.status we fall back to no filter (filter in code).
          listResult = await DimeService.listRecurringPayments(customerId, tenantId, { status: 'Failed' });
        } catch (err) {
          logger.warn(`  listRecurringPayments failed for group ${group.GroupName}: ${err.message}`);
          continue;
        }
        const schedules = listResult.schedules || [];
        if (schedules.length === 0) {
          logger.info(`  No recurring payments (or none Failed in list) for "${group.GroupName}" (customer_uuid: ${customerId})`);
        }
        for (const schedule of schedules) {
          const scheduleStatus = (schedule.status || '').toString();
          const lastRunStatus = (schedule.last_run_status || '').toString();
          const isFailed = scheduleStatus === 'Failed' || lastRunStatus === 'Failed';
          if (!isFailed) continue;
          const lastRunDateRaw = schedule.last_run_date || schedule.last_run_date_utc || null;
          if (!lastRunDateRaw) continue;
          const lastRunDate = new Date(lastRunDateRaw);
          if (lastRunDate < startDate || lastRunDate > endDate) continue;
          const scheduleIdRaw = schedule.id ?? schedule.recurring_payment_id ?? null;
          const scheduleId = scheduleIdRaw != null ? String(scheduleIdRaw) : null;
          if (!scheduleId) continue;
          const amount = parseFloat(schedule.amount) || 0;
          const failureReason = schedule.error || schedule.failure_reason || 'Failed (from recurring list)';
          const syntheticId = `dime-failed-${scheduleId}-${lastRunDate.toISOString().replace(/\.\d{3}Z$/, 'Z')}`;

          const existing = await pool.request()
            .input('processorTransactionId', sql.NVarChar(255), syntheticId)
            .input('scheduleId', sql.NVarChar(255), scheduleId)
            .input('paymentDateStart', sql.DateTime2, new Date(lastRunDate.getFullYear(), lastRunDate.getMonth(), lastRunDate.getDate()))
            .input('paymentDateEnd', sql.DateTime2, new Date(lastRunDate.getFullYear(), lastRunDate.getMonth(), lastRunDate.getDate() + 1))
            .query(`
              SELECT PaymentId FROM oe.Payments
              WHERE (ProcessorTransactionId = @processorTransactionId)
                 OR (RecurringScheduleId = @scheduleId AND Status = 'Failed' AND PaymentDate >= @paymentDateStart AND PaymentDate < @paymentDateEnd)
            `);
          if (existing.recordset.length > 0) {
            stats.failedFromListSkipped++;
            continue;
          }

          const contextData = await matchTransactionToGroup(pool, group.GroupId, tenantId, scheduleId, logger);
          if (dryRun) {
            stats.dryRunWouldCreateFailed.push({
              processorTransactionId: syntheticId,
              amount,
              paymentDate: lastRunDate.toISOString(),
              groupId: group.GroupId,
              groupName: group.GroupName,
              scheduleId,
              failureReason
            });
            stats.failedFromListCreated++;
            logger.info(`  [DRY RUN] Would create failed payment from schedule: ${scheduleId} $${amount} ${group.GroupName} (${lastRunDate.toISOString().split('T')[0]}) reason: ${failureReason}`);
          } else {
            await createFailedRecurringPaymentRecord(pool, {
              groupId: contextData.groupId,
              tenantId: contextData.tenantId,
              householdId: contextData.householdId,
              enrollmentId: contextData.enrollmentId,
              agentId: contextData.agentId,
              locationId: contextData.locationId,
              invoiceId: contextData.invoiceId,
              scheduleId,
              amount,
              processorTransactionId: syntheticId,
              paymentDate: lastRunDate,
              failureReason,
              retryDate: null
            }, logger);
            stats.failedFromListCreated++;
            logger.success(`  Created failed payment from schedule: ${scheduleId} $${amount} ${group.GroupName} (FailureReason saved in oe.Payments: ${failureReason})`);
          }
        }
      }
    }

    const endTime = new Date();
    const duration = (endTime - startTime) / 1000;

    logger.section('DIME Payment Sync Completed');
    logger.info(`Duration: ${duration.toFixed(2)} seconds`);
    logger.info(`Customers Checked: ${stats.customersChecked}`);
    logger.info(`Customers With Transactions: ${stats.customersWithTransactions}`);
    logger.info(`Total Transactions Found: ${stats.totalTransactionsFound}`);
    logger.info(`Payments Created: ${stats.paymentsCreated}`);
    logger.info(`Payments Updated: ${stats.paymentsUpdated}`);
    logger.info(`Payments Skipped: ${stats.paymentsSkipped}`);
    logger.info(`Failed from list created: ${stats.failedFromListCreated}`);
    logger.info(`Failed from list skipped (already had payment): ${stats.failedFromListSkipped}`);
    logger.info(`Errors: ${stats.errors.length}`);

    context.res = {
      status: 200,
      body: {
        success: true,
        message: dryRun ? 'Dry run completed (no changes made)' : 'Payment sync completed',
        dryRun: dryRun || undefined,
        stats,
        duration: `${duration.toFixed(2)}s`,
        timestamp: endTime.toISOString()
      }
    };

  } catch (error) {
    logger.error(`Payment sync failed: ${error.message}`);
    logger.error(`Stack: ${error.stack}`);
    
    context.res = {
      status: 500,
      body: {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      }
    };
  } finally {
    if (pool) {
      await pool.close();
    }
  }
};

/**
 * Match transaction to group and find associated context (location, invoice, schedule, etc.)
 * Reuses logic from DimeWebhookHandler.handleRecurringPaymentSuccess()
 */
async function matchTransactionToGroup(pool, groupId, tenantId, scheduleId, logger) {
  let locationId = null;
  let invoiceId = null;
  let enrollmentId = null;
  let agentId = null;
  let householdId = null;

  // If we have a schedule ID, try to find group recurring payment plan
  if (scheduleId) {
    const groupResult = await pool.request()
      .input('scheduleId', sql.NVarChar(255), scheduleId)
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT 
          grp.LocationId,
          grp.InvoiceId,
          e.EnrollmentId,
          e.AgentId
        FROM oe.GroupRecurringPaymentPlans grp
        INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
        LEFT JOIN (
          SELECT TOP 1 EnrollmentId, AgentId, MemberId
          FROM oe.Enrollments
          WHERE Status = 'Active'
          ORDER BY EffectiveDate DESC
        ) e ON EXISTS (
          SELECT 1 FROM oe.Members m 
          WHERE m.MemberId = e.MemberId AND m.GroupId = g.GroupId
        )
        WHERE grp.DimeScheduleId = @scheduleId
          AND grp.GroupId = @groupId
      `);

    if (groupResult.recordset.length > 0) {
      const row = groupResult.recordset[0];
      locationId = row.LocationId || null;
      invoiceId = row.InvoiceId || null;
      enrollmentId = row.EnrollmentId || null;
      agentId = row.AgentId || null;
      logger.info(`    Found group recurring payment plan: LocationId=${locationId}, InvoiceId=${invoiceId}`);
    } else {
      // Check if it's an individual recurring payment
      const individualResult = await pool.request()
        .input('scheduleId', sql.NVarChar(255), scheduleId)
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`
          SELECT TOP 1 
            p.HouseholdId,
            p.EnrollmentId,
            p.AgentId
          FROM oe.Payments p
          WHERE p.RecurringScheduleId = @scheduleId
            AND p.GroupId = @groupId
          ORDER BY p.CreatedDate DESC
        `);

      if (individualResult.recordset.length > 0) {
        const row = individualResult.recordset[0];
        householdId = row.HouseholdId;
        enrollmentId = row.EnrollmentId;
        agentId = row.AgentId;
        logger.info(`    Found individual recurring payment: HouseholdId=${householdId}`);
      }
    }
  }

  // If we still don't have enrollment/agent info, try to get from group
  if (!enrollmentId || !agentId) {
    const enrollmentResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT TOP 1 
          e.EnrollmentId,
          e.AgentId
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @groupId
          AND e.Status = 'Active'
        ORDER BY e.EffectiveDate DESC
      `);

    if (enrollmentResult.recordset.length > 0) {
      enrollmentId = enrollmentId || enrollmentResult.recordset[0].EnrollmentId;
      agentId = agentId || enrollmentResult.recordset[0].AgentId;
    }
  }

  return {
    groupId,
    tenantId,
    locationId,
    invoiceId,
    enrollmentId,
    agentId,
    householdId
  };
}

/**
 * Derive a simple status (completed/failed/pending) from DIME transaction fields.
 * DIME list response may have empty status_code/status_text; transaction_status e.g. "CC Pending", "CC Approved".
 */
function deriveTransactionStatus(statusCode, statusText, transactionStatus) {
  if (statusCode !== null && statusCode !== undefined && statusCode !== '') {
    if (statusCode === '00' && statusText?.toLowerCase().includes('approved')) return 'completed';
    if (statusCode && statusCode !== '00') return 'failed';
  }
  const ts = (transactionStatus || '').toLowerCase();
  if (ts.includes('approved') || ts.includes('completed') || ts.includes('success') || ts.includes('settled')) return 'completed';
  if (ts.includes('pending') || ts.includes('processing')) return 'pending';
  if (ts.includes('failed') || ts.includes('declined') || ts.includes('returned')) return 'failed';
  if (ts) return 'pending'; // e.g. "CC Pending"
  return 'Unknown';
}

/**
 * Normalize DIME transaction_type to our PaymentMethod display (CC -> Credit Card, ACH -> ACH).
 */
function normalizeDimeTransactionType(type) {
  if (!type) return 'Unknown';
  const t = String(type).toUpperCase();
  if (t === 'CC') return 'Credit Card';
  if (t === 'ACH') return 'ACH';
  return type;
}

/**
 * Map DIME transaction status to our payment status (Completed, Pending, Failed, etc.)
 * Handles status_code+status_text, transaction_status (e.g. "CC Pending", "CC Approved"), and legacy dimeStatus string.
 */
function mapDimeStatusToPaymentStatus(dimeStatus, statusCode = null, statusText = null, transactionStatus = null) {
  if (statusCode !== null && statusCode !== undefined && statusCode !== '') {
    if (statusCode === '00' && statusText?.toLowerCase().includes('approved')) return 'Completed';
    if (statusCode && statusCode !== '00') return 'Failed';
  }
  const ts = (transactionStatus || '').toLowerCase();
  if (ts.includes('approved') || ts.includes('completed') || ts.includes('success') || ts.includes('settled')) return 'Completed';
  if (ts.includes('pending') || ts.includes('processing')) return 'Pending';
  if (ts.includes('failed') || ts.includes('declined') || ts.includes('returned')) return 'Failed';
  const statusMap = {
    'completed': 'Completed', 'success': 'Completed', 'succeeded': 'Completed',
    'failed': 'Failed', 'failure': 'Failed',
    'pending': 'Pending', 'processing': 'Pending',
    'refunded': 'Refunded', 'voided': 'Voided', 'canceled': 'Canceled', 'cancelled': 'Canceled'
  };
  const normalizedStatus = (dimeStatus || '').toLowerCase();
  return statusMap[normalizedStatus] || (ts ? 'Pending' : 'Unknown');
}

/**
 * Update invoice status if payment is completed
 * Reuses logic from DimeWebhookHandler.handleRecurringPaymentSuccess()
 */
async function updateInvoiceIfNeeded(pool, paymentId, amount, logger, invoiceId = null) {
  try {
    // If invoiceId not provided, try to get it from payment
    if (!invoiceId && paymentId) {
      const paymentResult = await pool.request()
        .input('paymentId', sql.UniqueIdentifier, paymentId)
        .query(`
          SELECT InvoiceId
          FROM oe.Payments
          WHERE PaymentId = @paymentId
        `);

      if (paymentResult.recordset.length > 0) {
        invoiceId = paymentResult.recordset[0].InvoiceId;
      }
    }

    if (invoiceId) {
      await pool.request()
        .input('invoiceId', sql.UniqueIdentifier, invoiceId)
        .input('amount', sql.Decimal(12,2), amount)
        .query(`
          UPDATE oe.Invoices
          SET Status = 'Paid',
              PaidAmount = @amount,
              PaymentReceivedDate = GETUTCDATE(),
              ModifiedDate = GETUTCDATE()
          WHERE InvoiceId = @invoiceId
        `);
      logger.info(`    Invoice ${invoiceId} marked as Paid`);
    }
  } catch (invoiceError) {
    logger.warn(`    Failed to update invoice status: ${invoiceError.message}`);
  }
}

