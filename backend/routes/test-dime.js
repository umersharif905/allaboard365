const express = require('express');
const router = express.Router();
const DimeService = require('../services/dimeService');

// Test endpoint for DIME customer creation
router.post('/test-customer', async (req, res) => {
  try {
    console.log('🧪 TEST: Creating DIME customer');
    
    const customerData = {
      firstName: 'Test',
      lastName: 'User',
      email: 'test@example.com',
      phone: '7707892072',
      billingAddress: '123 Test St',
      billingCity: 'Test City',
      billingState: 'CA',
      billingZip: '12345',
      billingCountry: 'US'
    };
    
    const result = await DimeService.createCustomer(customerData);
    
    res.json({
      success: true,
      message: 'Customer creation test completed',
      result: result
    });
    
  } catch (error) {
    console.error('❌ TEST ERROR:', error);
    res.status(500).json({
      success: false,
      message: 'Customer creation test failed',
      error: error.message
    });
  }
});

// Test endpoint for DIME payment method creation (Credit Card)
router.post('/test-payment-method-cc', async (req, res) => {
  try {
    console.log('🧪 TEST: Creating DIME credit card payment method');
    
    const cardData = {
      number: '4111111111111111',
      expiryMonth: 12,
      expiryYear: 2025,
      cvv: '123',
      cardholderName: 'Test User',
      billingAddress: {
        address: '123 Test St',
        address2: '',
        city: 'Test City',
        state: 'CA',
        zip: '12345',
        country: 'US'
      },
      customerId: req.body.customerId // Required
    };
    
    const result = await DimeService.createCreditCardPaymentMethod(cardData);
    
    res.json({
      success: true,
      message: 'Credit card payment method creation test completed',
      result: result
    });
    
  } catch (error) {
    console.error('❌ TEST ERROR:', error);
    res.status(500).json({
      success: false,
      message: 'Credit card payment method creation test failed',
      error: error.message
    });
  }
});

// Test endpoint for DIME payment method creation (ACH)
router.post('/test-payment-method-ach', async (req, res) => {
  try {
    console.log('🧪 TEST: Creating DIME ACH payment method');
    
    const bankData = {
      routingNumber: '021000021',
      accountNumber: '1234567890',
      accountType: 'Checking',
      accountHolderName: 'Test User',
      bankName: 'Test Bank',
      billingAddress: {
        address: '123 Test St',
        address2: '',
        city: 'Test City',
        state: 'CA',
        zip: '12345',
        country: 'US'
      },
      customerId: req.body.customerId // Required
    };
    
    const result = await DimeService.createBankAccountPaymentMethod(bankData);
    
    res.json({
      success: true,
      message: 'ACH payment method creation test completed',
      result: result
    });
    
  } catch (error) {
    console.error('❌ TEST ERROR:', error);
    res.status(500).json({
      success: false,
      message: 'ACH payment method creation test failed',
      error: error.message
    });
  }
});

// Test endpoint for DIME payment processing (Credit Card)
router.post('/test-payment-cc', async (req, res) => {
  try {
    console.log('🧪 TEST: Processing DIME credit card payment');
    
    const paymentData = {
      paymentMethodId: req.body.paymentMethodId,
      paymentMethodToken: req.body.paymentMethodToken,
      customerId: req.body.customerId,
      amount: 1000, // $10.00 in cents
      description: 'Test payment',
      paymentMethodType: 'Card',
      billingFirstName: 'Test',
      billingLastName: 'User',
      billingAddress: '123 Test St',
      billingCity: 'Test City',
      billingState: 'CA',
      billingZip: '12345'
    };
    
    const result = await DimeService.processPayment(paymentData);
    
    res.json({
      success: true,
      message: 'Credit card payment test completed',
      result: result
    });
    
  } catch (error) {
    console.error('❌ TEST ERROR:', error);
    res.status(500).json({
      success: false,
      message: 'Credit card payment test failed',
      error: error.message
    });
  }
});

// Test endpoint for DIME payment processing (ACH)
router.post('/test-payment-ach', async (req, res) => {
  try {
    console.log('🧪 TEST: Processing DIME ACH payment');
    
    const paymentData = {
      paymentMethodId: req.body.paymentMethodId,
      paymentMethodToken: req.body.paymentMethodToken,
      customerId: req.body.customerId,
      amount: 100, // $1.00 in cents (reduced to avoid transaction limits)
      description: 'Test payment',
      paymentMethodType: 'ACH',
      billingFirstName: 'Test',
      billingLastName: 'User',
      billingAddress: '123 Test St',
      billingCity: 'Test City',
      billingState: 'CA',
      billingZip: '12345'
    };
    
    // Try different approaches based on request parameters
    if (req.body.usePaymentMethodId) {
      console.log('🔬 Testing ACH with payment_method_id approach');
      // This would require modifying DimeService to try payment_method_id
    }
    
    if (req.body.useToken) {
      console.log('🔬 Testing ACH with token approach');
      // This would require modifying DimeService to try token field
    }
    
    const result = await DimeService.processPayment(paymentData);
    
    res.json({
      success: true,
      message: 'ACH payment test completed',
      result: result
    });
    
  } catch (error) {
    console.error('❌ TEST ERROR:', error);
    res.status(500).json({
      success: false,
      message: 'ACH payment test failed',
      error: error.message
    });
  }
});

// Test endpoint for DIME payment method validation
router.post('/test-validate-payment-method', async (req, res) => {
  try {
    console.log('🧪 TEST: Validating DIME payment method');
    
    const result = await DimeService.validatePaymentMethod(
      req.body.paymentMethodId,
      req.body.customerId
    );
    
    res.json({
      success: true,
      message: 'Payment method validation test completed',
      result: result
    });
    
  } catch (error) {
    console.error('❌ TEST ERROR:', error);
    res.status(500).json({
      success: false,
      message: 'Payment method validation test failed',
      error: error.message
    });
  }
});

// Test endpoint for DIME payment method deletion
router.delete('/test-payment-method/:paymentMethodId', async (req, res) => {
  try {
    console.log('🧪 TEST: Deleting DIME payment method');
    
    const result = await DimeService.deletePaymentMethod(req.params.paymentMethodId);
    
    res.json({
      success: true,
      message: 'Payment method deletion test completed',
      result: result
    });
    
  } catch (error) {
    console.error('❌ TEST ERROR:', error);
    res.status(500).json({
      success: false,
      message: 'Payment method deletion test failed',
      error: error.message
    });
  }
});

// Test endpoint for direct credit card charging (no stored payment method)
router.post('/test-direct-cc-charge', async (req, res) => {
  try {
    console.log('🧪 TEST: Direct Credit Card Charge');
    
    const paymentData = {
      customerId: req.body.customerId,
      cardNumber: req.body.cardNumber,
      cardholderName: req.body.cardholderName,
      expirationDate: req.body.expirationDate,
      cvv: req.body.cvv,
      amount: req.body.amount,
      description: req.body.description,
      paymentMethodType: 'Card',
      billingFirstName: 'Test',
      billingLastName: 'User',
      billingAddress: '123 Test St',
      billingCity: 'Test City',
      billingState: 'CA',
      billingZip: '12345'
    };
    
    const result = await DimeService.processPayment(paymentData);
    
    res.json({
      success: true,
      message: 'Direct credit card charge test completed',
      result: result
    });
    
  } catch (error) {
    console.error('❌ TEST ERROR:', error);
    res.status(500).json({
      success: false,
      message: 'Direct credit card charge test failed',
      error: error.message
    });
  }
});

// Test endpoint for direct ACH charging (no stored payment method)
router.post('/test-direct-ach-charge', async (req, res) => {
  try {
    console.log('🧪 TEST: Direct ACH Charge');
    
    const paymentData = {
      customerId: req.body.customerId,
      routingNumber: req.body.routingNumber,
      accountNumber: req.body.accountNumber,
      accountType: req.body.accountType,
      accountHolderName: req.body.accountName,
      amount: req.body.amount,
      description: req.body.description,
      paymentMethodType: 'ACH',
      billingFirstName: 'Test',
      billingLastName: 'User',
      billingAddress: '123 Test St',
      billingCity: 'Test City',
      billingState: 'CA',
      billingZip: '12345'
    };
    
    const result = await DimeService.processPayment(paymentData);
    
    res.json({
      success: true,
      message: 'Direct ACH charge test completed',
      result: result
    });
    
  } catch (error) {
    console.error('❌ TEST ERROR:', error);
    res.status(500).json({
      success: false,
      message: 'Direct ACH charge test failed',
      error: error.message
    });
  }
});

module.exports = router;
