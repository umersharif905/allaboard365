/**
 * Commission Trigger - Azure SQL Trigger Function
 * Monitors oe.Payments table for new payments and creates/updates commissions
 * 
 * Handles:
 * - INSERT: Create commissions for new payments (Status='Completed' or 'Draft')
 * - UPDATE: Recalculate commissions when Draft payments are finalized (Status='Draft' → 'Completed')
 * 
 * Note: This uses the v1 programming model. For v2, see function.json configuration.
 */

const { getPool, sql } = require('./db');
const { createLogger } = require('./logger');

// Import CommissionService - need to adapt it for Azure Functions context
// Since we're in oe_payment_manager, we need to access backend services
const path = require('path');
const CommissionService = require(path.join(__dirname, '../../backend/services/commissionService.advances'));

// For Azure Functions v1 programming model
module.exports = async function (context, changes) {
  const logger = createLogger(context);
  logger.info('Commission trigger fired', { changeCount: changes.length });

  let pool;
  let successCount = 0;
  let errorCount = 0;

  try {
    pool = await getPool();

    for (const change of changes) {
      if (change.operation === 'Insert') {
        const payment = change.item;
        
        try {
          // Process both Draft and Completed payments
          // Draft payments create Draft commissions (expected/estimated)
          // Completed payments create Pending commissions (final)
          const processableStatuses = ['Completed', 'Draft', 'APPROVAL', 'SUCCESS', 'COMPLETED', 'succeeded'];
          if (!processableStatuses.includes(payment.Status)) {
            logger.info(`Skipping payment ${payment.PaymentId} - status is ${payment.Status}`);
            continue;
          }

          // Get payment details from database (trigger only provides changed columns)
          const request = pool.request();
          request.input('PaymentId', sql.UniqueIdentifier, payment.PaymentId);
          
          const paymentResult = await request.query(`
            SELECT 
              p.PaymentId,
              p.HouseholdId,
              p.GroupId,
              p.PaymentDate,
              p.Amount,
              p.AgentId,
              p.Status,
              p.Commission,
              p.OverrideRate,
              p.NetRate
            FROM oe.Payments p
            WHERE p.PaymentId = @PaymentId
          `);

          if (paymentResult.recordset.length === 0) {
            logger.warn(`Payment not found: ${payment.PaymentId}`);
            continue;
          }

          const paymentData = paymentResult.recordset[0];

          // Determine commission status based on payment status
          const commissionStatus = paymentData.Status === 'Draft' ? 'Draft' : 'Pending';

          // Create commissions for this payment
          // Use the allocated commission pool from oe.Payments (same as NACHA service)
          // TenantId will be derived from oe.Agents in the commission service
          const result = await CommissionService.createCommissionsForPayment({
            paymentId: paymentData.PaymentId,
            householdId: paymentData.HouseholdId,
            groupId: paymentData.GroupId,
            paymentDate: paymentData.PaymentDate,
            enrollmentId: null,
            productId: null,
            paymentAmount: parseFloat(paymentData.Amount),
            agentId: paymentData.AgentId,
            tenantId: null, // Will be derived from oe.Agents in commission service
            commission: paymentData.Commission !== null && paymentData.Commission !== undefined ? parseFloat(paymentData.Commission) : null,
            overrideRate: paymentData.OverrideRate !== null && paymentData.OverrideRate !== undefined ? parseFloat(paymentData.OverrideRate) : 0,
            netRate: paymentData.NetRate !== null && paymentData.NetRate !== undefined ? parseFloat(paymentData.NetRate) : null,
            commissionStatus: commissionStatus // Pass status to create Draft or Pending commissions
          });

          successCount++;
          logger.info(`Commissions created for payment ${paymentData.PaymentId}`, {
            commissionsCreated: result.commissionsCreated,
            status: commissionStatus
          });

        } catch (error) {
          errorCount++;
          logger.error(`Failed to create commissions for payment ${payment.PaymentId}`, {
            error: error.message,
            stack: error.stack
          });
          // Don't throw - continue processing other payments
          // Azure Functions will retry failed executions automatically
        }
      }
      
      else if (change.operation === 'Update') {
        const payment = change.item;
        
        try {
          // Only process if status changed to Completed (Draft → Completed)
          // This happens when a Draft payment is finalized
          const completedStatuses = ['Completed', 'APPROVAL', 'SUCCESS', 'COMPLETED', 'succeeded'];
          if (!completedStatuses.includes(payment.Status)) {
            logger.info(`Skipping payment update ${payment.PaymentId} - status is ${payment.Status}`);
            continue;
          }

          // Get full payment details from database
          const request = pool.request();
          request.input('PaymentId', sql.UniqueIdentifier, payment.PaymentId);
          
          const paymentResult = await request.query(`
            SELECT 
              p.PaymentId,
              p.HouseholdId,
              p.GroupId,
              p.PaymentDate,
              p.Amount,
              p.AgentId,
              p.Status,
              p.Commission,
              p.OverrideRate,
              p.NetRate
            FROM oe.Payments p
            WHERE p.PaymentId = @PaymentId
          `);

          if (paymentResult.recordset.length === 0) {
            logger.warn(`Payment not found: ${payment.PaymentId}`);
            continue;
          }

          const paymentData = paymentResult.recordset[0];

          // Check if Draft commissions exist for this payment
          const checkRequest = pool.request();
          checkRequest.input('PaymentId', sql.UniqueIdentifier, payment.PaymentId);
          const existingCommissions = await checkRequest.query(`
            SELECT CommissionId
            FROM oe.Commissions
            WHERE PaymentId = @PaymentId AND Status = 'Draft'
          `);

          if (existingCommissions.recordset.length > 0) {
            // Delete existing Draft commissions (will be recalculated with new amounts)
            const deleteRequest = pool.request();
            deleteRequest.input('PaymentId', sql.UniqueIdentifier, payment.PaymentId);
            await deleteRequest.query(`
              DELETE FROM oe.Commissions
              WHERE PaymentId = @PaymentId AND Status = 'Draft'
            `);
            
            logger.info(`Deleted ${existingCommissions.recordset.length} Draft commission(s) for payment ${payment.PaymentId}`);
          }

          // Recalculate and create new commissions with updated amounts
          // Status will be 'Pending' (not 'Draft') since payment is now Completed
          const result = await CommissionService.createCommissionsForPayment({
            paymentId: paymentData.PaymentId,
            householdId: paymentData.HouseholdId,
            groupId: paymentData.GroupId,
            paymentDate: paymentData.PaymentDate,
            enrollmentId: null,
            productId: null,
            paymentAmount: parseFloat(paymentData.Amount),
            agentId: paymentData.AgentId,
            tenantId: null, // Will be derived from oe.Agents in commission service
            commission: paymentData.Commission !== null && paymentData.Commission !== undefined ? parseFloat(paymentData.Commission) : null,
            overrideRate: paymentData.OverrideRate !== null && paymentData.OverrideRate !== undefined ? parseFloat(paymentData.OverrideRate) : 0,
            netRate: paymentData.NetRate !== null && paymentData.NetRate !== undefined ? parseFloat(paymentData.NetRate) : null,
            commissionStatus: 'Pending' // Final commissions are Pending (not Draft)
          });

          successCount++;
          logger.info(`Commissions updated for payment ${paymentData.PaymentId}`, {
            commissionsCreated: result.commissionsCreated,
            previousDraftCount: existingCommissions.recordset.length
          });

        } catch (error) {
          errorCount++;
          logger.error(`Failed to update commissions for payment ${payment.PaymentId}`, {
            error: error.message,
            stack: error.stack
          });
          // Don't throw - continue processing other payments
          // Azure Functions will retry failed executions automatically
        }
      }
    }

    logger.info('Commission trigger completed', {
      totalChanges: changes.length,
      successCount,
      errorCount
    });

  } catch (error) {
    logger.error('Commission trigger error', {
      error: error.message,
      stack: error.stack
    });
    throw error; // Will trigger retry
  }
};

