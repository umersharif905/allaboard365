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

const NMI_GATEWAY_URL = 'https://secure.nmi.com/api/transact.php';
const NMI_QUERY_URL   = 'https://secure.nmi.com/api/query.php';

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

    const nmiSettings = paymentSettings.processors?.openenroll?.nmi;
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
      timeout: 30000
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
        type:         'add_customer',
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

      const params = {
        security_key:      config.securityKey,
        type:              'sale',
        amount:            Number(paymentData.amount).toFixed(2),
        customer_vault_id: paymentData.customerVaultId,
        order_description: (paymentData.description || 'Enrollment payment').replace(/[^\w\s,.'-]/g, ''),
        orderid:           paymentData.orderId || ''
      };

      // If no vault ID, fall back to raw card data (one-time charge)
      if (!paymentData.customerVaultId && paymentData.cardNumber) {
        delete params.customer_vault_id;
        params.ccnumber        = paymentData.cardNumber.replace(/\s/g, '');
        params.ccexp           = paymentData.ccexp || '';
        params.cvv             = paymentData.cvv   || '';
        params.first_name      = paymentData.firstName || '';
        params.last_name       = paymentData.lastName  || '';
        params.address1        = paymentData.address   || '';
        params.city            = paymentData.city      || '';
        params.state           = paymentData.state     || '';
        params.zip             = paymentData.zip       || '';
        params.email           = paymentData.email     || '';
      }

      const parsed = await this.post(params);

      if (!this.isApproved(parsed)) {
        const msg = parsed.responsetext || 'Payment declined';
        console.warn('⚠️ NMI payment declined:', { responsetext: parsed.responsetext, response_code: parsed.response_code });
        return {
          success:         false,
          transactionId:   parsed.transactionid || null,
          authCode:        parsed.authcode       || null,
          responseCode:    parsed.response_code  || null,
          error:           { message: msg, code: parsed.response_code }
        };
      }

      return {
        success:       true,
        transactionId: parsed.transactionid,
        authCode:      parsed.authcode,
        avsResponse:   parsed.avsresponse,
        cvvResponse:   parsed.cvvresponse,
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