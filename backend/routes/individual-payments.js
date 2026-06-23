const express = require('express');
const router = express.Router();
const DimeService = require('../services/dimeService');
const PaymentDatabaseService = require('../services/paymentDatabaseService');
const { authorize, requireTenantAccess } = require('../middleware/auth');
const posthog = require('../config/posthog');

/**
 * Process initial payment for individual enrollment
 * POST /api/individual-payments/process-initial
 */
router.post('/process-initial', authorize, requireTenantAccess, async (req, res) => {
  try {
    const { 
      memberId, 
      paymentMethodData, 
      amount, 
      description 
    } = req.body;

    // Validate required fields
    if (!memberId || !paymentMethodData || !amount) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: memberId, paymentMethodData, amount',
        error: {
          code: 'MISSING_REQUIRED_FIELDS',
          details: 'memberId, paymentMethodData, and amount are required'
        }
      });
    }

    // Get household ID for the member
    const householdResult = await PaymentDatabaseService.getHouseholdIdForMember(memberId);
    if (!householdResult.success) {
      return res.status(400).json({
        success: false,
        message: 'Could not find household for member',
        error: {
          code: 'HOUSEHOLD_NOT_FOUND',
          details: householdResult.error
        }
      });
    }

    const householdId = householdResult.householdId;

    // Calculate total premium amount for household
    const premiumResult = await PaymentDatabaseService.getHouseholdTotalPremium(householdId);
    if (!premiumResult.success) {
      return res.status(400).json({
        success: false,
        message: 'Could not calculate premium amount',
        error: {
          code: 'PREMIUM_CALCULATION_ERROR',
          details: premiumResult.error
        }
      });
    }

    // Validate amount matches calculated premium
    if (amount !== premiumResult.totalPremium) {
      return res.status(400).json({
        success: false,
        message: 'Payment amount does not match calculated premium',
        error: {
          code: 'AMOUNT_MISMATCH',
          details: `Expected ${premiumResult.totalPremium} cents, got ${amount} cents`
        }
      });
    }

    // Check if payment already exists for this household
    const existingPayment = await PaymentDatabaseService.getHouseholdPaymentStatus(householdId);
    if (existingPayment.success && existingPayment.payment && existingPayment.payment.Status === 'succeeded') {
      return res.status(400).json({
        success: false,
        message: 'Payment already exists for this household',
        error: {
          code: 'PAYMENT_ALREADY_EXISTS',
          details: 'A successful payment already exists for this household'
        }
      });
    }

    // Create or get DIME customer
    let customerId;
    if (paymentMethodData.customerId) {
      customerId = paymentMethodData.customerId;
    } else {
      const customerResult = await DimeService.createCustomer({
        firstName: paymentMethodData.cardholderName.split(' ')[0],
        lastName: paymentMethodData.cardholderName.split(' ').slice(1).join(' '),
        email: paymentMethodData.email,
        phone: paymentMethodData.phone,
        billingAddress: paymentMethodData.billingAddress
      }, req.tenantId);

      if (!customerResult.success) {
        return res.status(400).json({
          success: false,
          message: 'Failed to create customer',
          error: {
            code: 'CUSTOMER_CREATION_ERROR',
            details: customerResult.error
          }
        });
      }

      customerId = customerResult.customerId;
    }

    // Tokenize payment method if not already tokenized
    let paymentMethodId;
    if (paymentMethodData.paymentMethodId) {
      paymentMethodId = paymentMethodData.paymentMethodId;
    } else {
      const tokenizeResult = await DimeService.tokenizeCreditCard({
        ...paymentMethodData,
        customerId
      }, req.tenantId);

      if (!tokenizeResult.success) {
        return res.status(400).json({
          success: false,
          message: 'Failed to tokenize payment method',
          error: {
            code: 'TOKENIZATION_ERROR',
            details: tokenizeResult.error
          }
        });
      }

      paymentMethodId = tokenizeResult.paymentMethodId;
    }

    // Process initial payment
    const paymentResult = await DimeService.processInitialPayment({
      customerId,
      paymentMethodId,
      amount,
      description: description || `Initial payment for household ${householdId}`,
      householdId
    }, req.tenantId);

    if (!paymentResult.success) {
      return res.status(400).json({
        success: false,
        message: 'Payment processing failed',
        error: {
          code: 'PAYMENT_PROCESSING_ERROR',
          details: paymentResult.error
        }
      });
    }

    // Store payment record in database
    const paymentRecord = await PaymentDatabaseService.storePaymentRecord({
      householdId,
      amount,
      status: paymentResult.recordStatus || paymentResult.status || 'Completed',
      paymentMethod: 'dime',
      processorTransactionId: paymentResult.transactionId,
      processorResponse: JSON.stringify(paymentResult.processorResponse),
      paymentDate: new Date(),
      description: description || `Initial payment for household ${householdId}`
    });

    // Get effective date for recurring payment setup
    const effectiveDateResult = await PaymentDatabaseService.getHouseholdEffectiveDate(householdId);
    if (effectiveDateResult.success && effectiveDateResult.effectiveDate) {
      // Calculate next billing date (1 month after effective date)
      const nextBillingDate = new Date(effectiveDateResult.effectiveDate);
      nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);

      // Setup recurring payment
      const recurringResult = await DimeService.setupRecurringPayment({
        customerId,
        paymentMethodId,
        amount,
        description: `Recurring payment for household ${householdId}`,
        householdId,
        startDate: nextBillingDate
      }, req.tenantId);

      if (recurringResult.success && recurringResult.scheduleId) {
        const nextBd = recurringResult.nextBillingDate
          ? new Date(recurringResult.nextBillingDate)
          : nextBillingDate;
        await PaymentDatabaseService.persistRecurringScheduleAfterDimeSetup({
          householdId,
          tenantId: req.tenantId,
          recurringScheduleId: recurringResult.scheduleId,
          nextBillingDate: nextBd,
          monthlyAmount: Number(amount)
        });
      }
    }

    posthog.capture({
      distinctId: String(memberId),
      event: 'individual payment processed',
      properties: {
        household_id: String(householdId),
        amount_cents: amount,
        transaction_id: paymentResult.transactionId,
        payment_status: paymentResult.status,
        tenant_id: req.tenantId ? String(req.tenantId) : undefined,
      },
    });

    res.json({
      success: true,
      message: 'Payment processed successfully',
      data: {
        paymentId: paymentRecord.PaymentId,
        transactionId: paymentResult.transactionId,
        amount: paymentResult.amount,
        status: paymentResult.status,
        householdId,
        nextBillingDate: effectiveDateResult.success ? new Date(effectiveDateResult.effectiveDate).setMonth(new Date(effectiveDateResult.effectiveDate).getMonth() + 1) : null
      }
    });

  } catch (error) {
    posthog.captureException(error, req.body?.memberId ? String(req.body.memberId) : undefined);
    console.error('❌ Error processing individual payment:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error while processing payment',
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        details: error.message
      }
    });
  }
});

/**
 * Get payment status for household
 * GET /api/individual-payments/household/:householdId/status
 */
router.get('/household/:householdId/status', authorize, requireTenantAccess, async (req, res) => {
  try {
    const { householdId } = req.params;

    const result = await PaymentDatabaseService.getHouseholdPaymentStatus(householdId);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: 'Failed to get payment status',
        error: {
          code: 'PAYMENT_STATUS_ERROR',
          details: result.error
        }
      });
    }

    res.json({
      success: true,
      data: {
        payment: result.payment
      }
    });

  } catch (error) {
    console.error('❌ Error getting payment status:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error while getting payment status',
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        details: error.message
      }
    });
  }
});

/**
 * Get total premium amount for household
 * GET /api/individual-payments/household/:householdId/premium
 */
router.get('/household/:householdId/premium', authorize, requireTenantAccess, async (req, res) => {
  try {
    const { householdId } = req.params;

    const result = await PaymentDatabaseService.getHouseholdTotalPremium(householdId);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: 'Failed to calculate premium amount',
        error: {
          code: 'PREMIUM_CALCULATION_ERROR',
          details: result.error
        }
      });
    }

    res.json({
      success: true,
      data: {
        totalPremium: result.totalPremium
      }
    });

  } catch (error) {
    console.error('❌ Error calculating premium amount:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error while calculating premium amount',
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        details: error.message
      }
    });
  }
});

module.exports = router;
