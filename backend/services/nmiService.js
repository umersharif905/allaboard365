const axios = require('axios');
const { getPool, sql } = require('../config/database');
const encryptionService = require('./encryptionService');

/**
 * NMI Payment Processor Service
 *
 * NMI uses a single gateway URL for both sandbox and production.
 * Sandbox vs. production is determined purely by which credentials
 * (Security Key) you supply — sandbox credentials only process test
 * transactions, production credentials process real ones.
 *
 * Gateway URL: https://secure.nmi.com/api/transact.php  (Direct Post)
 * Collect.js tokenization: handled on the frontend using collectJsKey;
 * the resulting payment-token is then passed to this service for server-side ops.
 *
 * NMI API docs: https://secure.nmi.com/merchants/resources/integration/integration_portal.php
 */

// Change this at the top of the file
const NMI_GATEWAY_URL = 'https://pinnacle.transactiongateway.com/api/transact.php';
const NMI_QUERY_URL   = 'https://pinnacle.transactiongateway.com/api/query.php';
const NMI_TEST_CARD = {
  ccnumber: '4782780065328182',
  ccexp:    '0329',   // MM YY — December 2025
  cvv:      '916'
};
function mapNmiResponseToDbStatus(parsed) {
  if (String(parsed.response) === '1') return 'Completed';
  return 'Failed';
}

async function getNmiCustomerVaultId(pool, memberId) {
  const result = await pool.request()
    .input('MemberId', sql.UniqueIdentifier, memberId)
    .query(`
      SELECT TOP 1 
        NmiCustomerVaultId,
        ProcessorToken,
        ProcessorPaymentMethodId
      FROM oe.MemberPaymentMethods
      WHERE MemberId = @MemberId 
        AND Status = 'Active'
      ORDER BY IsDefault DESC
    `);
  const row = result.recordset?.[0];
  if (!row) return null;
  return row.NmiCustomerVaultId;
}

async function saveNmiCustomerVaultId(pool, memberId, paymentMethodId, customerVaultId) {
  await pool.request()
    .input('MemberId',          sql.UniqueIdentifier, memberId)
    .input('PaymentMethodId',   sql.UniqueIdentifier, paymentMethodId)
    .input('NmiCustomerVaultId', sql.NVarChar(255),   customerVaultId)
    .query(`
      UPDATE oe.MemberPaymentMethods
      SET NmiCustomerVaultId = @NmiCustomerVaultId,
          ModifiedDate = GETUTCDATE()
      WHERE MemberId = @MemberId
        AND PaymentMethodId = @PaymentMethodId
    `);
  console.log('✅ NMI: NmiCustomerVaultId saved to MemberPaymentMethods:', customerVaultId);
}

class NmiService {

  // ---------------------------------------------------------------------------
  // Config helpers
  // ---------------------------------------------------------------------------

  /**
   * Load and decrypt NMI credentials for a tenant from the database.
   * @param {string} tenantId
   * @returns {Promise<{securityKey, collectJsKey, environment, baseUrl, queryUrl, tenantId, tenantName}>}
   */
  static async getConfigForTenant(tenantId) {
    if (!tenantId) {
      throw new Error('❌ NMI Configuration Error: tenantId is required.');
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query('SELECT Name, PaymentProcessorSettings FROM oe.Tenants WHERE TenantId = @tenantId');

    if (result.recordset.length === 0) {
      throw new Error(`❌ NMI Configuration Error: Tenant ${tenantId} not found.`);
    }

    const tenantName = result.recordset[0].Name;

    if (!result.recordset[0].PaymentProcessorSettings) {
      throw new Error(`❌ NMI Configuration Error: Tenant "${tenantName}" has not configured payment processor credentials.`);
    }

    const paymentSettings = JSON.parse(result.recordset[0].PaymentProcessorSettings);

    if (paymentSettings.activeProcessor !== 'nmi') {
      throw new Error(`❌ NMI Configuration Error: Tenant "${tenantName}" is using ${paymentSettings.activeProcessor}, not NMI.`);
    }

    const nmiSettings = paymentSettings?.processors?.openenroll?.nmi;
    if (!nmiSettings) {
      throw new Error(`❌ NMI Configuration Error: Tenant "${tenantName}" has NMI selected but NMI credentials are missing.`);
    }

    // Decrypt security key (stored encrypted after our backend fix)
    const securityKey = nmiSettings.securityKeyEncrypted
      ? encryptionService.decrypt(nmiSettings.securityKeyEncrypted)
      : nmiSettings.securityKey;

    if (!securityKey) {
      throw new Error(`❌ NMI Configuration Error: Tenant "${tenantName}" is missing NMI Security Key. Configure it in Settings → Merchant Setup.`);
    }

    return {
      securityKey,
      collectJsKey: nmiSettings.collectJsKey || '',
      environment: nmiSettings.environment || 'sandbox',
      baseUrl:  NMI_GATEWAY_URL,
      queryUrl: NMI_QUERY_URL,
      tenantId,
      tenantName
    };
  }

  // ---------------------------------------------------------------------------
  // Low-level helpers
  // ---------------------------------------------------------------------------

  /**
   * Parse NMI's pipe-delimited or query-string style response body into an object.
   * NMI Direct Post API returns:  response=1&responsetext=SUCCESS&...
   */
  static parseNmiResponse(rawBody) {
    const params = new URLSearchParams(rawBody);
    const obj = {};
    for (const [k, v] of params.entries()) {
      obj[k] = v;
    }
    return obj;
  }

  /**
   * response=1 → Approved, response=2 → Declined, response=3 → Error
   */
  static isApproved(parsed) {
    return String(parsed.response) === '1';
  }

  /**
   * POST to NMI Direct Post API with form-encoded body.
   * Returns the parsed response object.
   */
  static async post(params) {
    const body = new URLSearchParams(params).toString();
    const response = await axios.post(NMI_GATEWAY_URL, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 3000000
    });
    return this.parseNmiResponse(response.data);
  }

  // ---------------------------------------------------------------------------
  // Tokenization  (Collect.js flow)
  // ---------------------------------------------------------------------------

  /**
   * Exchange a Collect.js payment-token for a vault customer/payment-method.
   * Collect.js runs on the frontend and calls NMI's JS library which returns
   * a one-time `payment_token`.  We then call add_customer here server-side
   * to vault it and get back a customer_vault_id + billing_id.
   *
   * @param {Object} opts
   * @param {string} opts.paymentToken   - One-time token from Collect.js
   * @param {string} opts.firstName
   * @param {string} opts.lastName
   * @param {string} opts.email
   * @param {string} opts.phone
   * @param {string} opts.address
   * @param {string} opts.city
   * @param {string} opts.state
   * @param {string} opts.zip
   * @param {string} tenantId
   */
  static async vaultPaymentToken(opts, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);

      const parsed = await this.post({
        security_key: config.securityKey,
        type:         'add_customer',
        payment_token: opts.paymentToken,
        first_name:   opts.firstName  || '',
        last_name:    opts.lastName   || '',
        email:        opts.email      || '',
        phone:        opts.phone      || '',
        address1:     opts.address    || '',
        city:         opts.city       || '',
        state:        opts.state      || '',
        zip:          opts.zip        || '',
        country:      opts.country    || 'US'
      });

      if (!this.isApproved(parsed)) {
        throw new Error(`NMI vault error: ${parsed.responsetext || 'Unknown error'} (code ${parsed.response_code})`);
      }

      return {
        success: true,
        customerVaultId: parsed.customer_vault_id,
        billingId:       parsed.billing_id,
        rawResponse:     parsed
      };
    } catch (error) {
      console.error('❌ NMI vaultPaymentToken error:', error.message);
      return { success: false, error: { message: error.message } };
    }
  }

  // ---------------------------------------------------------------------------
  // Customer vault
  // ---------------------------------------------------------------------------

  /**
   * Create a customer vault record directly (without Collect.js token).
   * Use vaultPaymentToken() when you have a Collect.js token instead.
   */
  static async createCustomer(customerData, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);

      const parsed = await this.post({
        security_key: config.securityKey,
        customer_vault:         'add_customer',
        first_name:   customerData.firstName  || '',
        last_name:    customerData.lastName   || '',
        email:        customerData.email      || '',
        phone:        customerData.phone      || '',
        address1:     customerData.address    || '',
        city:         customerData.city       || '',
        state:        customerData.state      || '',
        zip:          customerData.zip        || '',
        country:      customerData.country    || 'US',
        ccnumber:     customerData.cardNumber || '',
        ccexp:        customerData.ccexp      || '',  // MMYY
        cvv:          customerData.cvv        || ''
      });

      if (!this.isApproved(parsed)) {
        throw new Error(`NMI create customer error: ${parsed.responsetext}`);
      }

      return {
        success: true,
        customerId:      parsed.customer_vault_id,
        customerVaultId: parsed.customer_vault_id,
        rawResponse:     parsed
      };
    } catch (error) {
      console.error('❌ NMI createCustomer error:', error.message);
      return { success: false, error: { message: error.message } };
    }
  }

  /**
   * Retrieve a customer from the NMI vault by customer_vault_id.
   */
  static async getCustomer(customerVaultId, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);

      const body = new URLSearchParams({
        security_key:        config.securityKey,
        report_type:         'customer_vault',
        customer_vault_id:   customerVaultId
      }).toString();

      const response = await axios.post(NMI_QUERY_URL, body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000
      });

      // Query API returns XML — parse minimally
      const xml = response.data;
      const exists = xml.includes('<customer_vault>') && xml.includes(customerVaultId);

      return {
        success: true,
        found:   exists,
        rawXml:  xml
      };
    } catch (error) {
      console.error('❌ NMI getCustomer error:', error.message);
      return { success: false, error: { message: error.message } };
    }
  }

  // ---------------------------------------------------------------------------
  // Payments
  // ---------------------------------------------------------------------------

  /**
   * Charge a customer vault record (stored payment method).
   *
   * @param {Object} paymentData
   * @param {string} paymentData.customerVaultId  - NMI customer_vault_id
   * @param {number} paymentData.amount           - e.g. 49.99
   * @param {string} paymentData.description      - Order / memo description
   * @param {string} paymentData.orderId          - Your internal order/enrollment ID
   * @param {string} tenantId
   */
  static async processPayment(paymentData, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);

      // Step A: resolve vault ID — caller provided → DB lookup → create new
      let customerVaultId = paymentData.customerVaultId || paymentData.processorCustomerId || null;

      if (!customerVaultId && paymentData.memberId) {
        const pool = await getPool();
        console.log('🔍 NMI: No vault ID provided, checking MemberPaymentMethods...');
        customerVaultId = await getNmiCustomerVaultId(pool, paymentData.memberId);
        if (customerVaultId) {
          console.log('✅ NMI: Found existing NmiCustomerVaultId in DB:', customerVaultId);
        }
      }

      // Step B: still no vault ID — create new customer in NMI vault
      if (!customerVaultId) {
        console.log('🔍 NMI: No vault ID found, creating new NMI customer vault...');
       const vaultParams = {
        security_key:    config.securityKey,
        customer_vault:  'add_customer',
        amount:          '0.04',
        // Real customer info from paymentData
        first_name:      paymentData.firstName  || '',
        last_name:       paymentData.lastName   || '',
        email:           paymentData.email      || 'test@gmail.com',
        address1:        paymentData.address    || '',
        city:            paymentData.city       || '',
        state:           paymentData.state      || '',
        zip:             paymentData.zip        || '',
        country:         paymentData.country    || 'US',
        // Demo card — static for testing only
        ccnumber:        NMI_TEST_CARD.ccnumber,
        ccexp:           NMI_TEST_CARD.ccexp,
        cvv:             NMI_TEST_CARD.cvv
      };
      const jsonString_card_data = JSON.stringify(vaultParams);
      console.log('🔍 NMI: Creating new customer vault with params:', jsonString_card_data);


        // const vaultResult = await this.post();

        // ✅ Fix
        const vaultResult = await this.post(vaultParams);

        if (!this.isApproved(vaultResult)) {
          console.error('❌ NMI: Failed to create customer vault:', vaultResult.responsetext);
          return {
            success: false,
            error: {
              message: `Could not create NMI payment profile: ${jsonString_card_data}`,
              code: 'VAULT_CREATION_FAILED'
            }
          };
        }

        customerVaultId = vaultResult.customer_vault_id;
        console.log('✅ NMI: New customer vault created:', customerVaultId);

        // Step C: save to MemberPaymentMethods immediately
        if (paymentData.memberId && paymentData.paymentMethodId) {
          const pool = await getPool();
          await saveNmiCustomerVaultId(pool, paymentData.memberId, paymentData.paymentMethodId, customerVaultId);
        }
      }

      const params = {
        security_key:      config.securityKey,
        type:              'sale',
        amount:            '0.04',
        customer_vault_id: customerVaultId,
        order_description: (paymentData.description || 'Enrollment payment').replace(/[^\w\s,.'-]/g, ''),
        orderid:           `${paymentData.orderId || paymentData.invoiceId || 'INV'}-${Date.now()}`, 
      };


      const parsed = await this.post(params);

      const recordStatus = mapNmiResponseToDbStatus(parsed);

      // Always write to DB whether approved or declined
      const pool = await getPool();

    // Bind the real invoice amount for use in both Payments insert and Invoice update
    // const invoiceAmount = Number(paymentData.amount || 0.04).toFixed(2);
    const invoiceAmount = Number(0.04).toFixed(2);

await pool.request()
  .input('TenantId',               sql.UniqueIdentifier, tenantId)
  .input('Amount',                 sql.Decimal(10, 2),   parseFloat(invoiceAmount))
  .input('Status',                 sql.NVarChar(50),     recordStatus === 'Completed' ? 'succeeded' : 'failed')
  .input('ProcessorTransactionId', sql.NVarChar(255),    parsed.transactionid || null)
  .input('PaymentMethod',          sql.NVarChar(50),     'Card')
  .input('Processor',              sql.NVarChar(50),     'NMI')
  .input('NmiCustomerVaultId',     sql.NVarChar(255),    customerVaultId || null)
  .input('IsVerificationCharge',   sql.Bit,              1)
  .input('ErrorMessage',           sql.NVarChar(sql.MAX), recordStatus === 'Failed' ? (parsed.responsetext || null) : null)
  .input('Description',            sql.NVarChar(500),    paymentData.description || 'NMI test verification')
  .input('HouseholdId',            sql.UniqueIdentifier, paymentData.householdId || null)
  .input('AgentId',                sql.UniqueIdentifier, paymentData.agentId     || null)
  .query(`
    INSERT INTO oe.Payments (
      TenantId, Amount, Status,
      ProcessorTransactionId, PaymentMethod,
      Processor, IsVerificationCharge,
      FailureReason,
      PaymentDate, CreatedDate, ModifiedDate, NmiCustomerVaultId,
      HouseholdId, AgentId
    ) VALUES (
      @TenantId, @Amount, @Status,
      @ProcessorTransactionId, @PaymentMethod,
      @Processor, @IsVerificationCharge,
      @ErrorMessage,
      GETUTCDATE(), GETUTCDATE(), GETUTCDATE(), @NmiCustomerVaultId,
      @HouseholdId, @AgentId
    )
  `);

console.log('✅ NMI: Payment record inserted into DB');

// Update invoice status AFTER successful DB insert
// Update invoice status AFTER successful DB insert
if (this.isApproved(parsed)) {
  // 🔍 Debug: log what invoiceId we received
  console.log('🔍 NMI: paymentData.invoiceId =', paymentData.invoiceId);

  if (paymentData.invoiceId) {
    try {
      await pool.request()
        .input('InvoiceId', sql.UniqueIdentifier, paymentData.invoiceId)
        .input('PaidAmount', sql.Decimal(10, 2), parseFloat(invoiceAmount))
        .query(`
          UPDATE oe.Invoices 
          SET 
            Status = 'Paid',
            PaymentReceivedDate = GETUTCDATE(),
            PaidAmount = @PaidAmount,
            ModifiedDate = GETUTCDATE()
          WHERE InvoiceId = @InvoiceId
        `);
      console.log('✅ NMI: Invoice marked as Paid:', paymentData.invoiceId);
    } catch (invoiceErr) {
      // ⚠️ Don't crash the whole payment if invoice update fails
      // Payment already succeeded and is in DB — just log it
      console.error('❌ NMI: Invoice update failed (payment still succeeded):', invoiceErr.message);
    }
  } else {
    console.warn('⚠️ NMI: No invoiceId provided — skipping invoice status update');
  }
}

if (!this.isApproved(parsed)) {
  const msg = parsed.responsetext || 'Payment declined';
  console.warn('⚠️ NMI payment declined:', { responsetext: parsed.responsetext, response_code: parsed.response_code });
  return {
    success:       false,
    transactionId: parsed.transactionid || null,
    authCode:      parsed.authcode       || null,
    responseCode:  parsed.response_code  || null,
    recordStatus,
    error:         { message: msg, code: parsed.response_code }
  };
}

// Void the $0.04 immediately so client card is not charged
// try {
//   await this.post({
//     security_key:  config.securityKey,
//     type:          'void',
//     transactionid: parsed.transactionid
//   });
//   console.log('✅ NMI $0.04 test charge voided successfully:', parsed.transactionid);
// } catch (voidErr) {
//   // Non-fatal — log but don't fail the overall payment
//   console.error('❌ NMI void failed after $0.04 charge — manual refund needed:', parsed.transactionid, voidErr.message);
// }

return {
  success:       true,
  transactionId: parsed.transactionid,
  authCode:      parsed.authcode,
  avsResponse:   parsed.avsresponse,
  cvvResponse:   parsed.cvvresponse,
  recordStatus,
  rawResponse:   parsed
};
    } catch (error) {
      console.error('❌ NMI processPayment error:', error.message);
      return { success: false, error: { message: error.message } };
    }
  }

  /**
   * Refund (credit) a previously settled NMI transaction.
   *
   * @param {string} transactionId  - NMI transactionid to refund
   * @param {number} amount         - Amount to refund (must be <= original)
   * @param {string} tenantId
   */
  static async refundTransaction(transactionId, amount, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);

      const parsed = await this.post({
        security_key:  config.securityKey,
        type:          'refund',
        transactionid: transactionId,
        amount:        Number(amount).toFixed(2)
      });

      if (!this.isApproved(parsed)) {
        throw new Error(`NMI refund error: ${parsed.responsetext} (code ${parsed.response_code})`);
      }

      return {
        success:            true,
        refundTransactionId: parsed.transactionid,
        rawResponse:         parsed
      };
    } catch (error) {
      console.error('❌ NMI refundTransaction error:', error.message);
      return { success: false, error: { message: error.message } };
    }
  }

  /**
   * Void a transaction that has not yet settled.
   * @param {string} transactionId
   * @param {string} tenantId
   */
  static async voidTransaction(transactionId, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);

      const parsed = await this.post({
        security_key:  config.securityKey,
        type:          'void',
        transactionid: transactionId
      });

      if (!this.isApproved(parsed)) {
        throw new Error(`NMI void error: ${parsed.responsetext}`);
      }

      return { success: true, rawResponse: parsed };
    } catch (error) {
      console.error('❌ NMI voidTransaction error:', error.message);
      return { success: false, error: { message: error.message } };
    }
  }

  // ---------------------------------------------------------------------------
  // Recurring / subscriptions
  // ---------------------------------------------------------------------------

  /**
   * Create a recurring payment plan on NMI for a vaulted customer.
   *
   * @param {Object} scheduleData
   * @param {string} scheduleData.customerVaultId
   * @param {number} scheduleData.amount            - Monthly amount
   * @param {string} scheduleData.startDate         - YYYYMMDD
   * @param {string} scheduleData.planName          - Descriptive name shown in NMI portal
   * @param {string} tenantId
   */
  static async setupRecurringPayment(scheduleData, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);

      const parsed = await this.post({
        security_key:      config.securityKey,
        type:              'add_subscription',
        customer_vault_id: scheduleData.customerVaultId,
        plan_amount:       Number(scheduleData.amount).toFixed(2),
        plan_payments:     scheduleData.planPayments   || '0',   // 0 = until cancelled
        plan_name:         (scheduleData.planName      || 'Enrollment subscription').slice(0, 64),
        day_frequency:     scheduleData.dayFrequency   || '',
        month_frequency:   scheduleData.monthFrequency || '1',   // 1 = monthly
        day_of_month:      scheduleData.dayOfMonth     || '1',
        start_date:        scheduleData.startDate      || ''     // YYYYMMDD
      });

      if (!this.isApproved(parsed)) {
        throw new Error(`NMI recurring setup error: ${parsed.responsetext}`);
      }

      return {
        success:        true,
        subscriptionId: parsed.subscription_id,
        rawResponse:    parsed
      };
    } catch (error) {
      console.error('❌ NMI setupRecurringPayment error:', error.message);
      return { success: false, error: { message: error.message } };
    }
  }

  /**
   * Cancel a recurring subscription.
   * @param {string} subscriptionId  - NMI subscription_id
   * @param {string} tenantId
   */
  static async cancelRecurringPayment(subscriptionId, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);

      const parsed = await this.post({
        security_key:    config.securityKey,
        type:            'delete_subscription',
        subscription_id: subscriptionId
      });

      if (!this.isApproved(parsed)) {
        throw new Error(`NMI cancel subscription error: ${parsed.responsetext}`);
      }

      return { success: true, rawResponse: parsed };
    } catch (error) {
      console.error('❌ NMI cancelRecurringPayment error:', error.message);
      return { success: false, error: { message: error.message } };
    }
  }

  // ---------------------------------------------------------------------------
  // Payment method management
  // ---------------------------------------------------------------------------

  /**
   * Delete a payment method (billing record) from the customer vault.
   * @param {string} customerVaultId
   * @param {string} billingId
   * @param {string} tenantId
   */
  static async deletePaymentMethod(customerVaultId, billingId, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);

      const parsed = await this.post({
        security_key:      config.securityKey,
        type:              'delete_customer',
        customer_vault_id: customerVaultId,
        billing_id:        billingId
      });

      if (!this.isApproved(parsed)) {
        throw new Error(`NMI delete payment method error: ${parsed.responsetext}`);
      }

      return { success: true, rawResponse: parsed };
    } catch (error) {
      console.error('❌ NMI deletePaymentMethod error:', error.message);
      return { success: false, error: { message: error.message } };
    }
  }

  // ---------------------------------------------------------------------------
  // Transaction lookup
  // ---------------------------------------------------------------------------

  /**
   * Query a single transaction by NMI transaction ID.
   * @param {string} transactionId
   * @param {string} tenantId
   */
  static async getTransactionStatus(transactionId, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);

      const body = new URLSearchParams({
        security_key:   config.securityKey,
        report_type:    'transaction',
        transaction_id: transactionId
      }).toString();

      const response = await axios.post(NMI_QUERY_URL, body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000
      });

      return {
        success: true,
        rawXml:  response.data
      };
    } catch (error) {
      console.error('❌ NMI getTransactionStatus error:', error.message);
      return { success: false, error: { message: error.message } };
    }
  }
}

module.exports = NmiService;