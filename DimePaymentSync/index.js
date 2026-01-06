const { getPool, sql } = require('../shared/db');
const DimeService = require('../shared/dimeService');
const { createLogger } = require('../shared/logger');

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
      errors: []
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

    logger.info(`Processing ${Object.keys(groupsByTenant).length} tenant(s)`);

    // Process each tenant's groups
    for (const [tenantId, tenantGroups] of Object.entries(groupsByTenant)) {
      logger.subsection(`Processing Tenant: ${tenantId} (${tenantGroups.length} groups)`);

      for (const group of tenantGroups) {
        stats.customersChecked++;

        try {
          logger.info(`  Checking customer: ${group.ProcessorCustomerId} (${group.GroupName})`);

          // Query DIME for transactions for this customer
          const transactionsResult = await DimeService.listTransactions({
            start_date: startDateFormatted,
            end_date: endDateFormatted,
            customer_uuid: group.ProcessorCustomerId
          }, group.TenantId);

          if (!transactionsResult.success) {
            logger.warn(`    Failed to query DIME transactions: ${transactionsResult.error?.message || transactionsResult.message}`);
            stats.errors.push({
              groupId: group.GroupId,
              groupName: group.GroupName,
              customerId: group.ProcessorCustomerId,
              error: transactionsResult.error?.message || transactionsResult.message
            });
            continue;
          }

          const transactions = transactionsResult.transactions || [];

          if (transactions.length === 0) {
            logger.info(`    No transactions found for customer ${group.ProcessorCustomerId}`);
            continue;
          }

          stats.customersWithTransactions++;
          stats.totalTransactionsFound += transactions.length;
          logger.info(`    Found ${transactions.length} transaction(s) for customer ${group.ProcessorCustomerId}`);

          // Process each transaction
          // NEW DIME TRANSACTION API FORMAT (matches webhook structure):
          // - transaction_number instead of transaction_id
          // - amount is a string, needs parsing
          // - status_code and status_text instead of status
          // - transaction_type instead of payment_method
          // - customer_uuid at root level
          for (const transaction of transactions) {
            try {
              const transactionId = transaction.transaction_number || transaction.transaction_id || transaction.id || transaction.transactionNumber;
              const amount = parseFloat(transaction.amount) || 0;
              const statusCode = transaction.status_code;
              const statusText = transaction.status_text;
              // Map status_code "00" = Approved/Completed, others = Failed/Pending
              const status = (statusCode === '00' && statusText?.toLowerCase().includes('approved')) 
                ? 'completed' 
                : (statusCode ? 'failed' : 'Unknown');
              const paymentMethod = transaction.transaction_type || transaction.payment_method || transaction.paymentMethod || 'Unknown';
              const scheduleId = transaction.schedule_id || transaction.recurring_payment_id || null;
              const customerUuid = transaction.customer_uuid || group.ProcessorCustomerId;
              const transactionDate = transaction.transaction_date || transaction.fund_date || transaction.settle_date || transaction.date || transaction.created_at || new Date();

              if (!transactionId) {
                logger.warn(`    Skipping transaction without transaction_id: ${JSON.stringify(transaction)}`);
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
                const newStatus = mapDimeStatusToPaymentStatus(status, statusCode, statusText);

                if (currentStatus !== newStatus && newStatus !== 'Unknown') {
                  logger.info(`    Updating payment ${transactionId}: ${currentStatus} → ${newStatus}`);
                  
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

                  // If status changed to Completed and there's an invoice, update it
                  if (newStatus === 'Completed') {
                    await updateInvoiceIfNeeded(pool, existing.PaymentId, amount, logger);
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
              if (!finalScheduleId && customerUuid) {
                try {
                  const scheduleResult = await pool.request()
                    .input('customerUuid', sql.NVarChar(255), customerUuid)
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

              // Calculate pricing fields
              const pricing = await calculatePricingFields(
                pool,
                contextData.groupId,
                contextData.householdId,
                logger
              );

              // Determine payment date
              const paymentDate = transactionDate instanceof Date 
                ? transactionDate 
                : new Date(transactionDate);

              // Map DIME status to our payment status
              const paymentStatus = mapDimeStatusToPaymentStatus(status, statusCode, statusText);

              // Insert payment record
              await pool.request()
                .input('transactionType', sql.NVarChar(50), 'Payment')
                .input('amount', sql.Decimal(10,2), amount)
                .input('status', sql.NVarChar(50), paymentStatus)
                .input('processor', sql.NVarChar(50), 'DIME')
                .input('processorTransactionId', sql.NVarChar(255), transactionId)
                .input('paymentMethod', sql.NVarChar(50), paymentMethod)
                .input('recurringScheduleId', sql.NVarChar(255), scheduleId)
                .input('paymentDate', sql.DateTime2, paymentDate)
                .input('enrollmentId', sql.UniqueIdentifier, contextData.enrollmentId)
                .input('agentId', sql.UniqueIdentifier, contextData.agentId)
                .input('householdId', sql.UniqueIdentifier, contextData.householdId)
                .input('groupId', sql.UniqueIdentifier, contextData.groupId)
                .input('tenantId', sql.UniqueIdentifier, contextData.tenantId)
                .input('locationId', sql.UniqueIdentifier, contextData.locationId)
                .input('invoiceId', sql.UniqueIdentifier, contextData.invoiceId)
                .input('netRate', sql.Decimal(10,2), pricing.netRate)
                .input('commission', sql.Decimal(10,2), pricing.commission)
                .input('overrideRate', sql.Decimal(10,2), pricing.overrideRate)
                .input('systemFees', sql.Decimal(10,2), pricing.systemFees)
                .query(`
                  INSERT INTO oe.Payments (
                    PaymentId, EnrollmentId, AgentId, HouseholdId, GroupId, TenantId, LocationId, InvoiceId,
                    TransactionType, Amount, Status, Processor, 
                    ProcessorTransactionId, PaymentMethod, RecurringScheduleId, PaymentDate,
                    NetRate, Commission, OverrideRate, SystemFees,
                    CreatedDate, ModifiedDate
                  ) VALUES (
                    NEWID(), @enrollmentId, @agentId, @householdId, @groupId, @tenantId, @locationId, @invoiceId,
                    @transactionType, @amount, @status, @processor,
                    @processorTransactionId, @paymentMethod, @recurringScheduleId, @paymentDate,
                    @netRate, @commission, @overrideRate, @systemFees,
                    GETUTCDATE(), GETUTCDATE()
                  )
                `);

              stats.paymentsCreated++;
              logger.success(`    Created payment record for transaction ${transactionId}`);

              // Update invoice if this is a group payment with invoice
              if (contextData.invoiceId && paymentStatus === 'Completed') {
                await updateInvoiceIfNeeded(pool, null, amount, logger, contextData.invoiceId);
              }

            } catch (transactionError) {
              logger.error(`    Error processing transaction: ${transactionError.message}`);
              stats.errors.push({
                groupId: group.GroupId,
                groupName: group.GroupName,
                transactionId: transaction.transaction_id || transaction.id,
                error: transactionError.message
              });
            }
          }

        } catch (customerError) {
          logger.error(`  Error processing customer ${group.ProcessorCustomerId}: ${customerError.message}`);
          stats.errors.push({
            groupId: group.GroupId,
            groupName: group.GroupName,
            customerId: group.ProcessorCustomerId,
            error: customerError.message
          });
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
    logger.info(`Errors: ${stats.errors.length}`);

    context.res = {
      status: 200,
      body: {
        success: true,
        message: 'Payment sync completed',
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
 * Calculate pricing fields (netRate, commission, overrideRate, systemFees)
 * Reuses logic from DimeWebhookHandler.handleRecurringPaymentSuccess()
 */
async function calculatePricingFields(pool, groupId, householdId, logger) {
  let netRate = 0;
  let commission = 0;
  let overrideRate = 0;
  let systemFees = 0;

  try {
    if (householdId) {
      // Individual recurring payment - get pricing from household enrollments
      const pricingResult = await pool.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .query(`
          SELECT 
            SUM(COALESCE(e.NetRate, 0)) as NetRate,
            SUM(COALESCE(e.Commission, 0)) as Commission,
            SUM(COALESCE(e.OverrideRate, 0)) as OverrideRate,
            SUM(COALESCE(e.SystemFees, 0)) as SystemFees
          FROM oe.Enrollments e
          WHERE e.HouseholdId = @householdId
            AND e.Status = 'Active'
            AND e.EffectiveDate <= GETUTCDATE()
            AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
        `);

      if (pricingResult.recordset.length > 0) {
        netRate = pricingResult.recordset[0].NetRate || 0;
        commission = pricingResult.recordset[0].Commission || 0;
        overrideRate = pricingResult.recordset[0].OverrideRate || 0;
        systemFees = pricingResult.recordset[0].SystemFees || 0;
      }
    } else if (groupId) {
      // Group recurring payment - aggregate from all group enrollments
      const pricingResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`
          SELECT 
            SUM(COALESCE(e.NetRate, 0)) as NetRate,
            SUM(COALESCE(e.Commission, 0)) as Commission,
            SUM(COALESCE(e.OverrideRate, 0)) as OverrideRate,
            SUM(COALESCE(e.SystemFees, 0)) as SystemFees
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE m.GroupId = @groupId
            AND e.Status = 'Active'
            AND e.EffectiveDate <= GETUTCDATE()
            AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
        `);

      if (pricingResult.recordset.length > 0) {
        netRate = pricingResult.recordset[0].NetRate || 0;
        commission = pricingResult.recordset[0].Commission || 0;
        overrideRate = pricingResult.recordset[0].OverrideRate || 0;
        systemFees = pricingResult.recordset[0].SystemFees || 0;
      }
    }
  } catch (error) {
    logger.warn(`Could not aggregate pricing: ${error.message}`);
  }

  return { netRate, commission, overrideRate, systemFees };
}

/**
 * Map DIME transaction status to our payment status
 * Handles both old format (status string) and new format (status_code + status_text)
 */
function mapDimeStatusToPaymentStatus(dimeStatus, statusCode = null, statusText = null) {
  // NEW FORMAT: Use status_code and status_text if provided
  if (statusCode !== null && statusCode !== undefined) {
    // status_code "00" with "Approved" text = Completed
    if (statusCode === '00' && statusText?.toLowerCase().includes('approved')) {
      return 'Completed';
    }
    // Other status codes = Failed (or map specific codes if needed)
    if (statusCode && statusCode !== '00') {
      return 'Failed';
    }
  }
  
  // OLD FORMAT: Map status string
  const statusMap = {
    'completed': 'Completed',
    'success': 'Completed',
    'succeeded': 'Completed',
    'failed': 'Failed',
    'failure': 'Failed',
    'pending': 'Pending',
    'processing': 'Pending',
    'refunded': 'Refunded',
    'voided': 'Voided',
    'canceled': 'Canceled',
    'cancelled': 'Canceled'
  };

  const normalizedStatus = (dimeStatus || '').toLowerCase();
  return statusMap[normalizedStatus] || 'Unknown';
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

