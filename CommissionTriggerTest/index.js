/**
 * Commission Trigger Test Endpoint
 * Manually tests commission creation for a payment
 * 
 * This simulates what happens when a payment is inserted and the SQL trigger fires
 * 
 * Usage:
 * POST /api/test-commission-trigger
 * {
 *   "paymentId": "payment-uuid-here"
 * }
 * 
 * OR test with a payment from the webhook we just created:
 * POST /api/test-commission-trigger
 * {
 *   "paymentId": "latest"  // Uses the most recent payment
 * }
 */

const commissionTrigger = require('../shared/commissionTrigger');
const { getPool, sql } = require('../shared/db');
const { createLogger } = require('../shared/logger');

module.exports = async function (context, req) {
  const logger = createLogger(context);
  
  try {
    const { paymentId } = req.body;
    
    if (!paymentId) {
      context.res = {
        status: 400,
        body: {
          success: false,
          error: 'paymentId is required. Use "latest" to test with most recent payment.'
        }
      };
      return;
    }
    
    let targetPaymentId = paymentId;
    
    // If "latest", get the most recent payment
    if (paymentId === 'latest') {
      logger.info('Getting most recent payment...');
      const pool = await getPool();
      const result = await pool.request().query(`
        SELECT TOP 1 PaymentId
        FROM oe.Payments
        WHERE Status = 'Completed'
        ORDER BY CreatedDate DESC
      `);
      
      if (result.recordset.length === 0) {
        context.res = {
          status: 404,
          body: {
            success: false,
            error: 'No completed payments found in database'
          }
        };
        return;
      }
      
      targetPaymentId = result.recordset[0].PaymentId;
      logger.info(`Using latest payment: ${targetPaymentId}`);
      await pool.close();
    }
    
    // Get payment details to create mock trigger change
    const pool = await getPool();
    const paymentResult = await pool.request()
      .input('PaymentId', sql.UniqueIdentifier, targetPaymentId)
      .query(`
        SELECT 
          PaymentId,
          Status,
          Amount,
          GroupId,
          TenantId,
          HouseholdId,
          EnrollmentId,
          AgentId,
          Commission,
          OverrideRate,
          NetRate
        FROM oe.Payments
        WHERE PaymentId = @PaymentId
      `);
    
    if (paymentResult.recordset.length === 0) {
      context.res = {
        status: 404,
        body: {
          success: false,
          error: `Payment not found: ${targetPaymentId}`
        }
      };
      return;
    }
    
    const payment = paymentResult.recordset[0];
    
    // Check if commissions already exist
    const existingCommissions = await pool.request()
      .input('PaymentId', sql.UniqueIdentifier, targetPaymentId)
      .query(`
        SELECT COUNT(*) as CommissionCount
        FROM oe.Commissions
        WHERE PaymentId = @PaymentId
      `);
    
    const commissionCount = existingCommissions.recordset[0]?.CommissionCount || 0;
    
    logger.info(`Testing commission trigger for payment: ${targetPaymentId}`);
    logger.info(`  Status: ${payment.Status}`);
    logger.info(`  Amount: $${payment.Amount}`);
    logger.info(`  Existing commissions: ${commissionCount}`);
    
    // Create mock trigger change data (simulating SQL trigger)
    const mockChanges = [{
      operation: 'Insert',
      item: {
        PaymentId: payment.PaymentId,
        Status: payment.Status
      }
    }];
    
    // Call the commission trigger function directly
    await commissionTrigger(context, mockChanges);
    
    // Check if commissions were created
    const newCommissions = await pool.request()
      .input('PaymentId', sql.UniqueIdentifier, targetPaymentId)
      .query(`
        SELECT 
          CommissionId,
          Status,
          Amount,
          AgentId,
          CommissionType
        FROM oe.Commissions
        WHERE PaymentId = @PaymentId
        ORDER BY CreatedDate DESC
      `);
    
    await pool.close();
    
    const newCommissionCount = newCommissions.recordset.length;
    const createdCount = newCommissionCount - commissionCount;
    
    context.res = {
      status: 200,
      body: {
        success: true,
        message: 'Commission trigger test completed',
        paymentId: targetPaymentId,
        paymentStatus: payment.Status,
        paymentAmount: payment.Amount,
        existingCommissions: commissionCount,
        newCommissions: newCommissionCount,
        commissionsCreated: createdCount,
        commissions: newCommissions.recordset
      }
    };
    
  } catch (error) {
    logger.error('❌ Commission trigger test failed:', error);
    context.res = {
      status: 500,
      body: {
        success: false,
        error: error.message,
        stack: error.stack
      }
    };
  }
};

