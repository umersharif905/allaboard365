// Test endpoint for commission creation (bypasses Azure trigger)
// Only for development/testing purposes

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const CommissionService = require('../services/commissionService.advances');
const logger = require('../config/logger');

/**
 * @route POST /api/test/commissions/create
 * @desc Test commission creation for a payment (bypasses trigger)
 * @access Development only
 */
router.post('/create', async (req, res) => {
  try {
    const { paymentId } = req.body;

    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: 'PaymentId is required'
      });
    }

    // Get payment details
    const pool = await getPool();
    const request = pool.request();
    request.input('PaymentId', sql.UniqueIdentifier, paymentId);

    const paymentResult = await request.query(`
      SELECT 
        PaymentId, HouseholdId, GroupId, PaymentDate,
        Amount, AgentId, Status,
        Commission,
        OverrideRate,
        NetRate
      FROM oe.Payments
      WHERE PaymentId = @PaymentId
    `);

    if (paymentResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    const payment = paymentResult.recordset[0];

    // Handle both new normalized status ('Completed') and legacy statuses ('APPROVAL', 'SUCCESS', etc.)
    const completedStatuses = ['Completed', 'APPROVAL', 'SUCCESS', 'COMPLETED', 'succeeded'];
    if (!completedStatuses.includes(payment.Status)) {
      return res.status(400).json({
        success: false,
        message: `Payment status is '${payment.Status}', must be one of: ${completedStatuses.join(', ')}`
      });
    }

    // ProductId is derived in commission service from HouseholdId / GroupId + enrollments (oe.Payments.EnrollmentId is deprecated).

    // Call commission creation service
    // TenantId will be derived from oe.Agents using AgentId
    const result = await CommissionService.createCommissionsForPayment({
      paymentId: payment.PaymentId,
      householdId: payment.HouseholdId,
      groupId: payment.GroupId,
      paymentDate: payment.PaymentDate,
      enrollmentId: null,
      productId: null,
      paymentAmount: parseFloat(payment.Amount),
      agentId: payment.AgentId,
      tenantId: null, // Will be derived from oe.Agents in commission service
      commission: payment.Commission !== null && payment.Commission !== undefined ? parseFloat(payment.Commission) : null,
      overrideRate: payment.OverrideRate !== null && payment.OverrideRate !== undefined ? parseFloat(payment.OverrideRate) : 0,
      netRate: payment.NetRate !== null && payment.NetRate !== undefined ? parseFloat(payment.NetRate) : null
    });

    logger.info('Test commission creation completed', {
      paymentId,
      commissionsCreated: result.commissionsCreated
    });

    res.json({
      success: true,
      message: `Created ${result.commissionsCreated} commission(s)`,
      commissionsCreated: result.commissionsCreated,
      paymentId: paymentId
    });

  } catch (error) {
    logger.error('Error in test commission creation', {
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      message: 'Failed to create commissions',
      error: error.message
    });
  }
});

module.exports = router;

