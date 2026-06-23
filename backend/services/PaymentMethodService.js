const DimeService = require('./dimeService');
const dimeCardBrand = require('./dimeCardBrand');
const cardValidator = require('card-validator');
const encryptionService = require('./encryptionService');
const { getPool, sql } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

/**
 * Unified Payment Method Service
 * 
 * This service extracts common payment method creation patterns from across the system
 * without changing any existing functionality. All behavior remains identical.
 * 
 * Used by:
 * - /api/me/member/payment-methods (Member payment methods)
 * - /api/groups/:groupId/payment-method (Group payment methods)
 * - /api/group-onboarding/:linkToken/complete (Group onboarding)
 * - /api/enrollment-links/:linkToken/complete-enrollment (Individual enrollment)
 */
class PaymentMethodService {
  
  /**
   * Ensure DIME customer exists for an entity (member or group)
   * @param {Object} customerData - Customer information
   * @param {string} entityType - 'member' or 'group'
   * @param {string} entityId - MemberId or GroupId
   * @param {string} tenantId - Tenant ID for DIME credentials (REQUIRED)
   * @param {Object} transaction - Database transaction (optional)
   * @returns {Promise<Object>} Customer ID and creation status
   */
  static async ensureDimeCustomer(customerData, entityType, entityId, tenantId, transaction = null) {
    const pool = transaction || await getPool();
    
    // Get existing customer ID
    const existingCustomerQuery = `
      SELECT ProcessorCustomerId
      FROM ${entityType === 'member' ? 'oe.Members' : 'oe.Groups'}
      WHERE ${entityType === 'member' ? 'MemberId' : 'GroupId'} = @entityId
    `;
    
    const existingCustomerRequest = pool.request();
    existingCustomerRequest.input('entityId', sql.UniqueIdentifier, entityId);
    const existingCustomerResult = await existingCustomerRequest.query(existingCustomerQuery);
    
    let dimeCustomerId = existingCustomerResult.recordset[0]?.ProcessorCustomerId;
    
    if (!dimeCustomerId) {
      // Create new DIME customer
      console.log(`🔍 Creating new DIME customer for ${entityType}:`, customerData.email);
      
      const customerResult = await DimeService.createCustomer(customerData, tenantId);
      if (!customerResult.success) {
        console.error('❌ Failed to create DIME customer:', customerResult.error);
        
        // Check for specific error types
        if (customerResult.error?.message?.includes('phone number already exists')) {
          return {
            success: false,
            error: {
              message: 'Phone number is already in use by another customer. Please use a different phone number.',
              code: 'PHONE_NUMBER_CONFLICT'
            }
          };
        }
        
        if (customerResult.error?.message?.includes('email has already been taken')) {
          return {
            success: false,
            error: {
              message: 'Email address is already in use by another customer. Please use a different email address.',
              code: 'EMAIL_CONFLICT'
            }
          };
        }
        
        return {
          success: false,
          error: {
            message: customerResult.error?.message || customerResult.message || 'Failed to create customer in payment processor',
            code: customerResult.error?.code || 'CUSTOMER_CREATION_ERROR',
            details: customerResult.error || null
          }
        };
      }
      
      dimeCustomerId = customerResult.customerId;
      console.log('✅ Created new DIME customer ID:', dimeCustomerId);
      
      // Store the DIME customer ID
      const updateCustomerIdQuery = `
        UPDATE ${entityType === 'member' ? 'oe.Members' : 'oe.Groups'}
        SET ProcessorCustomerId = @customerId, ModifiedDate = GETUTCDATE()
        WHERE ${entityType === 'member' ? 'MemberId' : 'GroupId'} = @entityId
      `;
      
      const updateCustomerIdRequest = pool.request();
      updateCustomerIdRequest.input('customerId', sql.NVarChar, dimeCustomerId);
      updateCustomerIdRequest.input('entityId', sql.UniqueIdentifier, entityId);
      await updateCustomerIdRequest.query(updateCustomerIdQuery);
      
      console.log(`✅ Stored DIME customer ID in ${entityType} table`);
    }
    
    return {
      success: true,
      customerId: dimeCustomerId
    };
  }
  
  /**
   * Create payment method with DIME using the correct two-step process for PCI compliance
   * @param {Object} paymentData - Payment method data
   * @param {string} customerId - DIME customer ID
   * @param {string} tenantId - Tenant ID for DIME credentials (REQUIRED)
   * @param {Object} options - Configuration options
   * @param {boolean} options.requireTokenization - Whether tokenization is required (default: true)
   *   - Set to true (default) for all contexts - ensures PCI compliance
   *   - Set to false only in special cases where recurring-only billing is acceptable
   * @returns {Promise<Object>} Payment method creation result with proper tokenization
   */
  static async createPaymentMethod(paymentData, customerId, tenantId, options = {}) {
    const { paymentMethodType } = paymentData;
    const { requireTokenization = true } = options; // Default to true - tokenization is important for security
    
    // Prepare billing address for DIME
    // Note: DimeService is imported at the top of the file
    const billingAddressData = {
      address: paymentData.billingAddress || '',
      address2: paymentData.billingAddress2 || '',
      city: paymentData.billingCity || '',
      state: paymentData.billingState || '',
      zip: DimeService.formatZipCode(paymentData.billingZip || ''),
      country: paymentData.billingCountry || 'US'
    };
    
    let dimeResult = null;
    
    if (paymentMethodType === 'ACH') {
      // ACH: Single step - create payment method (no tokenization available)
      dimeResult = await DimeService.createBankAccountPaymentMethod({
        routingNumber: paymentData.routingNumber,
        accountNumber: paymentData.accountNumber,
        accountType: paymentData.accountType || 'Checking',
        accountHolderName: paymentData.accountHolderName,
        bankName: paymentData.bankName,
        billingAddress: billingAddressData,
        customerId: customerId
      }, tenantId);
    } else if (paymentMethodType === 'CreditCard' || paymentMethodType === 'Card') {
      // Credit Card: TWO-STEP process required for proper tokenization
      console.log('🔍 DEBUG: Starting two-step credit card process');
      
      // Step 1: Create payment method in DIME vault (for recurring payments)
      // Returns raw card number in "token" field (not actually tokenized)
      const createResult = await DimeService.createCreditCardPaymentMethod({
        number: paymentData.cardNumber,
        expiryMonth: paymentData.expiryMonth.toString().padStart(2, '0'),
        expiryYear: paymentData.expiryYear.toString(),
        cvv: paymentData.cvv,
        cardholderName: paymentData.cardholderName,
        billingAddress: billingAddressData,
        customerId: customerId
      }, tenantId);
      
      if (!createResult.success) {
        console.error('❌ Step 1 failed: Payment method creation failed');
        return createResult;
      }
      
      console.log('✅ Step 1 complete: Payment method created (ID:', createResult.paymentMethodId, ')');
      console.log('⚠️ WARNING: Step 1 token is RAW card number (not tokenized)');
      
      // Step 2: Tokenize card for one-time payments (PCI compliance)
      // This returns ACTUAL tokenized token (NOT raw card number)
      console.log('🔍 DEBUG: Calling tokenization endpoint...');
      const tokenizeResult = await DimeService.tokenizeCreditCard({
        cardNumber: paymentData.cardNumber, // Use original card number (not the "token" from step 1)
        expiryMonth: paymentData.expiryMonth.toString().padStart(2, '0'),
        expiryYear: paymentData.expiryYear.toString(),
        cvv: paymentData.cvv,
        cardholderName: paymentData.cardholderName,
        customerId: customerId,
        billingAddress: {
          firstName: paymentData.cardholderName?.split(' ')[0] || 'John',
          lastName: paymentData.cardholderName?.split(' ').slice(1).join(' ') || 'Doe',
          address: paymentData.billingAddress || '',
          address2: paymentData.billingAddress2 || '',
          city: paymentData.billingCity || '',
          state: paymentData.billingState || '',
          zip: paymentData.billingZip || ''
        }
      }, tenantId);
      
      if (tokenizeResult.success) {
        console.log('✅ Step 2 complete: Card tokenized successfully');
        console.log('✅ Tokenized token:', tokenizeResult.token?.substring(0, 10) + '...');
        
        // Use TOKENIZED token (not raw card number from step 1)
        dimeResult = {
          success: true,
          token: tokenizeResult.token, // TOKENIZED token for one-time charges
          customerId: customerId,
          paymentMethodId: createResult.paymentMethodId, // Payment method ID for recurring charges
          cardBrand: createResult.cardBrand,
          last4: createResult.last4,
          expiryMonth: paymentData.expiryMonth,
          expiryYear: paymentData.expiryYear,
          rawResponse: {
            createResult: createResult.rawResponse,
            tokenizeResult: tokenizeResult.rawResponse
          }
        };
      } else {
        console.log('❌ Step 2 FAILED: Tokenization failed');
        
        // Check if tokenization is required (for one-time payments)
        if (requireTokenization) {
          console.error('🚨 CRITICAL: Tokenization required but failed - PCI violation risk!');
          console.error('Tokenization error:', tokenizeResult.error);
          
          // Return error for one-time payment contexts
          return {
            success: false,
            error: {
              message: 'Failed to tokenize credit card. This is required for PCI compliance.',
              code: 'TOKENIZATION_FAILED',
              details: tokenizeResult.error
            }
          };
        } else {
          console.log('⚠️ WARNING: Tokenization failed but continuing (recurring payment context)');
          console.log('ℹ️ Payment method can be used for recurring payments but NOT for one-time charges');
          console.log('Tokenization error:', tokenizeResult.error);
          
          // For recurring payments, we can proceed with just the payment method ID
          // One-time charges won't work, but recurring charges will
          dimeResult = {
            success: true,
            token: null, // No tokenized token available - one-time charges disabled
            customerId: customerId,
            paymentMethodId: createResult.paymentMethodId, // Payment method ID for recurring charges
            cardBrand: createResult.cardBrand,
            last4: createResult.last4,
            expiryMonth: paymentData.expiryMonth,
            expiryYear: paymentData.expiryYear,
            tokenizationFailed: true, // Flag to indicate one-time charges won't work
            rawResponse: {
              createResult: createResult.rawResponse,
              tokenizeResult: null
            }
          };
        }
      }
      
      console.log('✅ Two-step credit card process complete:', {
        hasTokenizedToken: !!dimeResult.token,
        tokenLength: dimeResult.token?.toString().length,
        hasPaymentMethodId: !!dimeResult.paymentMethodId,
        paymentMethodId: dimeResult.paymentMethodId
      });
      
    } else {
      return {
        success: false,
        error: {
          message: 'Invalid payment method type',
          code: 'INVALID_PAYMENT_METHOD_TYPE'
        }
      };
    }
    
    return dimeResult;
  }

  /**
   * Tokenize payment method with DIME (DEPRECATED - use createPaymentMethod instead)
   * @param {Object} paymentData - Payment method data
   * @param {string} customerId - DIME customer ID
   * @param {string} tenantId - Tenant ID for DIME credentials (REQUIRED)
   * @returns {Promise<Object>} Tokenization result
   * @deprecated Use createPaymentMethod instead
   */
  static async tokenizePaymentMethod(paymentData, customerId, tenantId) {
    console.warn('⚠️ tokenizePaymentMethod is deprecated. Use createPaymentMethod instead.');
    return this.createPaymentMethod(paymentData, customerId, tenantId);
  }
  
  /**
   * Insert payment method into database
   * @param {Object} paymentMethodData - Payment method data
   * @param {string} entityType - 'member' or 'group'
   * @param {string} entityId - MemberId or GroupId
   * @param {Object} dimeResult - DIME tokenization result
   * @param {string} userId - User ID for audit fields
   * @param {string} tenantId - Tenant ID (for members only)
   * @param {Object} transaction - Database transaction (optional)
   * @returns {Promise<Object>} Insert result
   */
  static async insertPaymentMethod(paymentMethodData, entityType, entityId, dimeResult, userId, tenantId = null, transaction = null, locationId = null) {
    const pool = transaction || await getPool();
    
    // Encrypt sensitive payment data before storage
    const encryptedPaymentData = encryptionService.encryptPaymentData(paymentMethodData);
    
    const { paymentMethodType } = encryptedPaymentData;
    let accountNumberLast4 = null;
    let cardLast4 = null;
    
    // Extract last 4 digits based on payment type (use original data for last 4)
    if (paymentMethodType === 'ACH' && paymentMethodData.accountNumber) {
      accountNumberLast4 = paymentMethodData.accountNumber.slice(-4);
    } else if ((paymentMethodType === 'CreditCard' || paymentMethodType === 'Card') && paymentMethodData.cardNumber) {
      cardLast4 = paymentMethodData.cardNumber.slice(-4);
    }
    
    // Card brand for display/DB: prefer DIME response, else derive from PAN (DIME cc_brand strings)
    let cardBrand = null;
    if ((paymentMethodType === 'CreditCard' || paymentMethodType === 'Card') && paymentMethodData.cardNumber) {
      const pan = dimeCardBrand.normalizePan(paymentMethodData.cardNumber);
      cardBrand = dimeResult.cardBrand || dimeCardBrand.getCardBrandOrNull(pan) || null;
    }
    
    // Build insert query based on entity type - INCLUDES ENCRYPTED FIELDS
    let insertQuery;
    let insertRequest;
    
    if (entityType === 'member') {
      insertQuery = `
        INSERT INTO oe.MemberPaymentMethods (
          PaymentMethodId, MemberId, TenantId, PaymentMethodType, IsDefault, Status,
          BankName, AccountType, AccountNumberLast4, AccountHolderName, RoutingNumber,
          CardBrand, CardLast4, ExpiryMonth, ExpiryYear, CardholderName,
          BillingAddress, BillingAddress2, BillingCity, BillingState, BillingZip, BillingCountry,
          ProcessorToken, ProcessorCustomerId, ProcessorPaymentMethodId,
          CardNumberEncrypted, AccountNumberEncrypted, RoutingNumberEncrypted,
          CreatedBy, ModifiedBy, CreatedDate, ModifiedDate
        ) VALUES (
          @paymentMethodId, @memberId, @tenantId, @paymentMethodType, @isDefault, 'Active',
          @bankName, @accountType, @accountNumberLast4, @accountHolderName, @routingNumber,
          @cardBrand, @cardLast4, @expiryMonth, @expiryYear, @cardholderName,
          @billingAddress, @billingAddress2, @billingCity, @billingState, @billingZip, @billingCountry,
          @processorToken, @processorCustomerId, @processorPaymentMethodId,
          @cardNumberEncrypted, @accountNumberEncrypted, @routingNumberEncrypted,
          @userId, @userId, GETUTCDATE(), GETUTCDATE()
        )
      `;
      
      insertRequest = pool.request();
      insertRequest.input('memberId', sql.UniqueIdentifier, entityId);
      insertRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
    } else {
      // For groups, use Type (actual column name in GroupPaymentMethods table)
      // Include LocationId if provided (for location-specific payment methods)
      insertQuery = `
        INSERT INTO oe.GroupPaymentMethods (
          PaymentMethodId, GroupId, LocationId, Type, IsDefault, Status,
          BankName, AccountType, AccountNumberLast4, AccountHolderName, RoutingNumber,
          CardBrand, CardLast4, ExpiryMonth, ExpiryYear, CardholderName,
          BillingAddress, BillingAddress2, BillingCity, BillingState, BillingZip, BillingCountry,
          ProcessorToken, ProcessorCustomerId, ProcessorPaymentMethodId,
          CardNumberEncrypted, AccountNumberEncrypted, RoutingNumberEncrypted,
          CreatedBy, ModifiedBy, CreatedDate, ModifiedDate
        ) VALUES (
          @paymentMethodId, @groupId, @locationId, @paymentMethodType, @isDefault, 'Active',
          @bankName, @accountType, @accountNumberLast4, @accountHolderName, @routingNumber,
          @cardBrand, @cardLast4, @expiryMonth, @expiryYear, @cardholderName,
          @billingAddress, @billingAddress2, @billingCity, @billingState, @billingZip, @billingCountry,
          @processorToken, @processorCustomerId, @processorPaymentMethodId,
          @cardNumberEncrypted, @accountNumberEncrypted, @routingNumberEncrypted,
          @userId, @userId, GETUTCDATE(), GETUTCDATE()
        )
      `;
      
      insertRequest = pool.request();
      insertRequest.input('groupId', sql.UniqueIdentifier, entityId);
      insertRequest.input('locationId', sql.UniqueIdentifier, locationId || null);
    }
    
    // Generate a GUID for the PaymentMethodId
    const generatedPaymentMethodId = uuidv4();
    
    // Set common parameters - REMOVED SENSITIVE DATA STORAGE
    insertRequest.input('paymentMethodId', sql.UniqueIdentifier, generatedPaymentMethodId);
    insertRequest.input('userId', sql.UniqueIdentifier, userId);
    insertRequest.input('paymentMethodType', sql.NVarChar, paymentMethodType);
    insertRequest.input('isDefault', sql.Bit, false); // Set to false initially, updatePaymentMethodDefaults will set to true
    insertRequest.input('bankName', sql.NVarChar, paymentMethodData.bankName || null);
    insertRequest.input('accountType', sql.NVarChar, paymentMethodData.accountType || null);
    // REMOVED: accountNumber - sensitive data not stored
    insertRequest.input('accountNumberLast4', sql.NVarChar, accountNumberLast4);
    insertRequest.input('accountHolderName', sql.NVarChar, paymentMethodData.accountHolderName || null);
    insertRequest.input('routingNumber', sql.NVarChar, paymentMethodData.routingNumber || null);
    insertRequest.input('cardBrand', sql.NVarChar, cardBrand);
    insertRequest.input('cardLast4', sql.NVarChar, cardLast4);
    insertRequest.input('expiryMonth', sql.Int, paymentMethodData.expiryMonth || null);
    insertRequest.input('expiryYear', sql.Int, paymentMethodData.expiryYear || null);
    insertRequest.input('cardholderName', sql.NVarChar, paymentMethodData.cardholderName || null);
    insertRequest.input('billingAddress', sql.NVarChar, paymentMethodData.billingAddress || null);
    insertRequest.input('billingAddress2', sql.NVarChar, paymentMethodData.billingAddress2 || null);
    insertRequest.input('billingCity', sql.NVarChar, paymentMethodData.billingCity || null);
    insertRequest.input('billingState', sql.NVarChar, paymentMethodData.billingState || null);
    insertRequest.input('billingZip', sql.NVarChar, paymentMethodData.billingZip || null);
    insertRequest.input('billingCountry', sql.NVarChar, paymentMethodData.billingCountry || 'US');

    const processorCustomerId = String(dimeResult.customerId || '');
    const isCard =
      paymentMethodType === 'CreditCard' ||
      paymentMethodType === 'Card';
    let processorPaymentMethodId;
    let processorToken;

    if (isCard) {
      const taas = dimeResult.token != null ? String(dimeResult.token).trim() : '';
      const pmVaultId =
        dimeResult.paymentMethodId != null ? String(dimeResult.paymentMethodId).trim() : '';

      // Never persist DIME vault id as ProcessorToken (charge-card expects TaaS multi-use token).
      if (!taas || !pmVaultId) {
        try {
          if (pmVaultId) await DimeService.deletePaymentMethod(dimeResult.paymentMethodId, tenantId);
        } catch (_) {}
        return {
          success: false,
          error: {
            message:
              'Card was not fully saved for billing: processor token missing. Retry or contact support.',
            code: 'MISSING_CARD_PROCESSOR_TOKEN'
          }
        };
      }

      processorToken = taas;
      processorPaymentMethodId = pmVaultId;
      console.log('🔍 DEBUG: Card processor fields:', {
        hasTaasToken: !!processorToken,
        tokenPreview: `${processorToken.substring(0, 6)}…`,
        processorPaymentMethodId: processorPaymentMethodId
      });
    } else {
      // ACH: no separate taas token — vault id covers recurring; match prior behavior
      processorPaymentMethodId = String(dimeResult.paymentMethodId || dimeResult.token || '').trim();
      processorToken =
        dimeResult.token != null && String(dimeResult.token).trim() !== ''
          ? String(dimeResult.token).trim()
          : processorPaymentMethodId;
    }

    console.log('🔍 DEBUG: Database processor values:', {
      paymentMethodType,
      processorTokenLength: processorToken?.length ?? 0,
      hasProcessorPaymentMethodId: !!processorPaymentMethodId,
      processorCustomerIdPresent: !!processorCustomerId
    });
    
    insertRequest.input('processorToken', sql.NVarChar, processorToken);
    insertRequest.input('processorCustomerId', sql.NVarChar, processorCustomerId);
    insertRequest.input('processorPaymentMethodId', sql.NVarChar, processorPaymentMethodId);
    
    // Add encrypted field parameters. CVV is intentionally never stored (PCI DSS 3.3.1).
    insertRequest.input('cardNumberEncrypted', sql.NVarChar, encryptedPaymentData.cardNumberEncrypted || null);
    insertRequest.input('accountNumberEncrypted', sql.NVarChar, encryptedPaymentData.accountNumberEncrypted || null);
    insertRequest.input('routingNumberEncrypted', sql.NVarChar, encryptedPaymentData.routingNumberEncrypted || null);
    
    let insertResult;
    try {
      insertResult = await insertRequest.query(insertQuery);
    } catch (dbError) {
      console.error('❌ Database error inserting payment method:', {
        message: dbError.message,
        code: dbError.code,
        originalError: dbError.originalError?.message,
        sqlError: dbError.originalError?.info?.message
      });
      
      // Clean up DIME payment method if database insert failed
      try {
        console.log('🧹 Cleaning up DIME payment method after database failure...');
        await DimeService.deletePaymentMethod(dimeResult.paymentMethodId, tenantId);
        console.log('✅ DIME payment method cleaned up successfully');
      } catch (cleanupError) {
        console.error('⚠️ Failed to clean up DIME payment method:', cleanupError);
      }
      
      // Check if error is due to missing column
      const errorMessage = dbError.message || dbError.originalError?.message || '';
      if (errorMessage.includes('LocationId') || errorMessage.includes('Invalid column name')) {
        return {
          success: false,
          error: {
            message: 'Database schema error: LocationId column not found. Please run the migration script: add-locationid-columns.sql',
            code: 'SCHEMA_ERROR',
            details: dbError.message
          }
        };
      }
      
      return {
        success: false,
        error: {
          message: `Database insert failed: ${errorMessage}`,
          code: 'DATABASE_INSERT_FAILED',
          details: dbError.message
        }
      };
    }
    
    if (insertResult.rowsAffected[0] === 0) {
      console.error('❌ Failed to insert payment method into database (no rows affected)');
      
      // Clean up DIME payment method if database insert failed
      try {
        console.log('🧹 Cleaning up DIME payment method after database failure...');
        await DimeService.deletePaymentMethod(dimeResult.paymentMethodId, tenantId);
        console.log('✅ DIME payment method cleaned up successfully');
      } catch (cleanupError) {
        console.error('⚠️ Failed to clean up DIME payment method:', cleanupError);
      }
      
      return {
        success: false,
        error: {
          message: 'Database insert failed - no rows affected',
          code: 'DATABASE_INSERT_FAILED'
        }
      };
    }
    
    console.log('✅ Payment method saved to database with DIME tokens, generated ID:', generatedPaymentMethodId);
    
    return {
      success: true,
      paymentMethodId: generatedPaymentMethodId,
      processorToken: processorToken,
      processorCustomerId: processorCustomerId
    };
  }
  
  /**
   * Update payment method defaults (remove default from others, set new default)
   * @param {string} entityType - 'member' or 'group'
   * @param {string} entityId - MemberId or GroupId
   * @param {string} newDefaultId - Payment method ID to set as default
   * @param {string} userId - User ID for audit fields
   * @param {string} tenantId - Tenant ID (for members only)
   * @param {Object} transaction - Database transaction (optional)
   * @returns {Promise<Object>} Update result
   */
  static async updatePaymentMethodDefaults(entityType, entityId, newDefaultId, userId, tenantId = null, transaction = null, locationId = null) {
    const dbConnection = transaction || await getPool();
    
    // Remove default from all other payment methods
    // For groups: scope by locationId if provided (location-specific defaults) or null (group-level defaults)
    let removeDefaultQuery;
    if (entityType === 'member') {
      removeDefaultQuery = `
        UPDATE oe.MemberPaymentMethods
        SET IsDefault = 0, ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
        WHERE MemberId = @entityId AND TenantId = @tenantId
      `;
    } else {
      // For groups, scope defaults by locationId
      // If locationId is provided, only update defaults for that location
      // If locationId is null, only update group-level defaults (where LocationId IS NULL)
      if (locationId !== null) {
        removeDefaultQuery = `
          UPDATE oe.GroupPaymentMethods
          SET IsDefault = 0, ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
          WHERE GroupId = @entityId AND LocationId = @locationId AND IsDefault = 1
        `;
      } else {
        removeDefaultQuery = `
          UPDATE oe.GroupPaymentMethods
          SET IsDefault = 0, ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
          WHERE GroupId = @entityId AND LocationId IS NULL AND IsDefault = 1
        `;
      }
    }
    
    const removeDefaultRequest = dbConnection.request();
    removeDefaultRequest.input('entityId', sql.UniqueIdentifier, entityId);
    removeDefaultRequest.input('userId', sql.UniqueIdentifier, userId);
    if (entityType === 'member') {
      removeDefaultRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
    } else if (entityType === 'group' && locationId !== null) {
      removeDefaultRequest.input('locationId', sql.UniqueIdentifier, locationId);
    }
    await removeDefaultRequest.query(removeDefaultQuery);
    
    // Set new default
    let setDefaultQuery;
    if (entityType === 'member') {
      setDefaultQuery = `
        UPDATE oe.MemberPaymentMethods
        SET IsDefault = 1, ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
        WHERE PaymentMethodId = @paymentMethodId
      `;
    } else {
      setDefaultQuery = `
        UPDATE oe.GroupPaymentMethods
        SET IsDefault = 1, ModifiedDate = GETUTCDATE(), ModifiedBy = @userId
        WHERE PaymentMethodId = @paymentMethodId
      `;
    }
    
    const setDefaultRequest = dbConnection.request();
    setDefaultRequest.input('paymentMethodId', sql.UniqueIdentifier, newDefaultId);
    setDefaultRequest.input('userId', sql.UniqueIdentifier, userId);
    await setDefaultRequest.query(setDefaultQuery);
    
    console.log('✅ Updated payment method defaults');
    
    return {
      success: true
    };
  }
  
  /**
   * Clean up failed DIME payment method
   * @param {string} dimePaymentMethodId - DIME payment method ID to delete
   * @param {string} tenantId - Tenant ID for DIME credentials (REQUIRED)
   * @returns {Promise<Object>} Cleanup result
   */
  static async cleanupFailedPaymentMethod(dimePaymentMethodId, tenantId) {
    try {
      console.log('🧹 Cleaning up DIME payment method:', dimePaymentMethodId);
      const deleteResult = await DimeService.deletePaymentMethod(dimePaymentMethodId, tenantId);
      
      if (deleteResult.success) {
        console.log('✅ DIME payment method cleaned up successfully');
      } else {
        console.warn('⚠️ Failed to clean up DIME payment method:', deleteResult.error);
      }
      
      return deleteResult;
    } catch (error) {
      console.error('❌ Error cleaning up DIME payment method:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Validate payment method data
   * @param {Object} paymentData - Payment method data
   * @param {string} paymentType - Payment method type
   * @returns {Object} Validation result
   */
  static validatePaymentMethodData(paymentData, paymentType) {
    const errors = {};
    
    // Common validation
    if (!paymentData.billingAddress) errors.billingAddress = 'Billing address is required';
    if (!paymentData.billingCity) errors.billingCity = 'City is required';
    if (!paymentData.billingState) errors.billingState = 'State is required';
    if (!paymentData.billingZip) errors.billingZip = 'ZIP code is required';
    
    if (paymentType === 'ACH') {
      // ACH validation
      if (!paymentData.bankName) errors.bankName = 'Bank name is required';
      if (!paymentData.routingNumber) errors.routingNumber = 'Routing number is required';
      else if (!/^\d{9}$/.test(paymentData.routingNumber)) {
        errors.routingNumber = 'Routing number must be 9 digits';
      }
      if (!paymentData.accountNumber) errors.accountNumber = 'Account number is required';
      if (!paymentData.accountHolderName) errors.accountHolderName = 'Account holder name is required';
      const rtAch = String(paymentData.routingNumber || '').replace(/\D/g, '');
      const acAch = String(paymentData.accountNumber || '').replace(/\D/g, '');
      if (rtAch.length === 9 && acAch.length >= 4 && rtAch === acAch) {
        errors.accountNumber = 'Account number cannot match the routing number';
      }
    } else if (paymentType === 'CreditCard' || paymentType === 'Card') {
      // Credit Card validation (PAN normalized; Luhn + DIME-supported brand via card-validator)
      if (!paymentData.cardNumber) errors.cardNumber = 'Card number is required';
      else {
        const cleanNumber = dimeCardBrand.normalizePan(paymentData.cardNumber);
        if (cleanNumber.length < 13) {
          errors.cardNumber = 'Card number must be at least 13 digits';
        } else if (cleanNumber.length > 19) {
          errors.cardNumber = 'Card number cannot exceed 19 digits';
        } else {
          const numVal = cardValidator.number(cleanNumber);
          if (!numVal.isValid) {
            errors.cardNumber = 'Card number is not valid';
          } else {
            const br = dimeCardBrand.getDimeCcBrandFromPan(cleanNumber);
            if (!br.brand) {
              errors.cardNumber = br.message || 'Unsupported card type';
            }
          }
        }
      }
      if (!paymentData.expiryMonth) errors.expiryMonth = 'Expiry month is required';
      if (!paymentData.expiryYear) errors.expiryYear = 'Expiry year is required';
      if (!paymentData.cvv) {
        errors.cvv = 'CVV is required';
      } else if (!/^\d{3,4}$/.test(paymentData.cvv)) {
        errors.cvv = 'CVV must be 3 or 4 digits';
      } else if (!errors.cardNumber && paymentData.cardNumber) {
        const cleanNumber = dimeCardBrand.normalizePan(paymentData.cardNumber);
        const numVal = cardValidator.number(cleanNumber);
        const cvvSizes = numVal.card && numVal.card.code && numVal.card.code.size
          ? [numVal.card.code.size]
          : [3, 4];
        const cvvCheck = cardValidator.cvv(String(paymentData.cvv), cvvSizes.length === 1 ? cvvSizes[0] : cvvSizes);
        if (!cvvCheck.isValid) {
          errors.cvv = cvvSizes[0] === 4 ? 'CVV must be 4 digits for this card' : 'CVV must be 3 digits';
        }
      }
      if (!paymentData.cardholderName) errors.cardholderName = 'Cardholder name is required';
      
      // Check if expiry date is in the past
      const currentDate = new Date();
      const currentYear = currentDate.getFullYear();
      const currentMonth = currentDate.getMonth() + 1;
      const expiryYear = parseInt(paymentData.expiryYear);
      const expiryMonth = parseInt(paymentData.expiryMonth);
      
      if (expiryYear < currentYear || (expiryYear === currentYear && expiryMonth < currentMonth)) {
        errors.expiryMonth = 'Card has expired';
      }
    }
    
    return {
      isValid: Object.keys(errors).length === 0,
      errors: errors
    };
  }

  /**
   * Retrieve and decrypt payment method data
   * @param {string} paymentMethodId - Payment method ID
   * @param {string} entityType - 'member' or 'group'
   * @param {Object} transaction - Database transaction (optional)
   * @returns {Promise<Object>} Decrypted payment method data
   */
  static async getPaymentMethod(paymentMethodId, entityType, transaction = null) {
    const pool = transaction || await getPool();
    
    const tableName = entityType === 'member' ? 'oe.MemberPaymentMethods' : 'oe.GroupPaymentMethods';
    const idField = entityType === 'member' ? 'MemberId' : 'GroupId';
    
    const query = `
      SELECT * FROM ${tableName}
      WHERE PaymentMethodId = @paymentMethodId
    `;
    
    const request = pool.request();
    request.input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId);
    
    const result = await request.query(query);
    
    if (result.recordset.length === 0) {
      return null;
    }
    
    const paymentMethod = result.recordset[0];
    
    // Decrypt sensitive data if encrypted fields exist (CVV is never stored so not checked).
    if (paymentMethod.cardNumberEncrypted || 
        paymentMethod.accountNumberEncrypted || 
        paymentMethod.routingNumberEncrypted) {
      
      try {
        const decryptedData = encryptionService.decryptPaymentData(paymentMethod);
        return { ...paymentMethod, ...decryptedData };
      } catch (error) {
        console.error('❌ Failed to decrypt payment method data:', error);
        // Return original data if decryption fails
        return paymentMethod;
      }
    }
    
    return paymentMethod;
  }
}

module.exports = PaymentMethodService;
