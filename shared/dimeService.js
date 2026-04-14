const axios = require('axios');
const { getPool, sql } = require('./db');
const encryptionService = require('./encryptionService');

/**
 * DIME Payments Service - Azure Functions Edition
 * Focused on recurring payment schedule management with per-tenant credentials
 */
class DimeService {
  /**
   * Get DIME configuration for a specific tenant from database
   * @param {string} tenantId - The tenant UUID
   * @returns {Promise<Object>} Configuration object with apiToken, sid, and baseUrl
   * @throws {Error} If tenant credentials are not configured
   */
  static async getConfigForTenant(tenantId) {
    if (!tenantId) {
      throw new Error('Tenant ID is required for DIME operations');
    }

    // Optional: use old/alternate merchant for sync (e.g. temporary override to fetch history from previous DIME merchant)
    const overrideBaseUrl = process.env.DIME_OVERRIDE_BASE_URL;
    const overrideApiToken = process.env.DIME_OVERRIDE_API_TOKEN;
    const overrideSid = process.env.DIME_OVERRIDE_SID;
    if (overrideBaseUrl && overrideApiToken && overrideSid) {
      console.log('DIME config: using override (DIME_OVERRIDE_* env) for tenant', tenantId);
      return {
        apiToken: overrideApiToken,
        sid: overrideSid,
        webhookSecret: process.env.DIME_OVERRIDE_WEBHOOK_SECRET || null,
        environment: 'production',
        baseUrl: overrideBaseUrl.replace(/\/$/, '')
      };
    }

    try {
      const pool = await getPool();
      
      const result = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT PaymentProcessorSettings
          FROM oe.Tenants
          WHERE TenantId = @tenantId
        `);

      if (result.recordset.length === 0) {
        throw new Error(`Tenant not found: ${tenantId}`);
      }

      const settingsJson = result.recordset[0].PaymentProcessorSettings;
      
      if (!settingsJson) {
        throw new Error(`DIME credentials not configured for tenant: ${tenantId}. Please configure payment processor settings in tenant admin settings.`);
      }

      const settings = JSON.parse(settingsJson);
      
      if (!settings.processors?.openenroll?.enabled) {
        throw new Error(`AllAboard365 payment processor not enabled for tenant: ${tenantId}`);
      }

      const dimeConfig = settings.processors.openenroll.dime;
      
      if (!dimeConfig) {
        throw new Error(`DIME configuration missing for tenant: ${tenantId}`);
      }

      // Decrypt sensitive fields
      const apiToken = dimeConfig.apiTokenEncrypted 
        ? encryptionService.decrypt(dimeConfig.apiTokenEncrypted)
        : dimeConfig.apiToken;
        
      const webhookSecret = dimeConfig.webhookSecretEncrypted
        ? encryptionService.decrypt(dimeConfig.webhookSecretEncrypted)
        : dimeConfig.webhookSecret;

      // Determine environment and base URL
      const environment = dimeConfig.environment;
      
      if (!environment) {
        throw new Error(`DIME environment not specified in tenant settings for tenant: ${tenantId}`);
      }
      
      // Derive base URL from environment (no fallbacks!)
      // NOTE: Production uses app.dimepayments.com (not api.dimepayments.com)
      // This matches the backend service implementation
      let baseUrl;
      if (environment === 'production') {
        baseUrl = 'https://app.dimepayments.com';
      } else if (environment === 'demo') {
        baseUrl = 'https://demo.dimepayments.com';
      } else {
        throw new Error(`Invalid DIME environment "${environment}" for tenant: ${tenantId}. Must be "production" or "demo".`);
      }

      return {
        apiToken,
        sid: dimeConfig.sid,
        webhookSecret,
        environment,
        baseUrl
      };
    } catch (error) {
      if (error.message.includes('DIME credentials not configured') || 
          error.message.includes('not enabled') ||
          error.message.includes('configuration missing')) {
        throw error;
      }
      console.error('Error fetching DIME config for tenant:', tenantId, error);
      throw new Error(`Failed to retrieve DIME configuration: ${error.message}`);
    }
  }

  /**
   * Create authenticated request headers with tenant-specific config
   * @param {Object} config - Configuration object from getConfigForTenant
   * @returns {Object} Headers for DIME API requests
   */
  static getHeaders(config) {
    return {
      'Authorization': `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  /**
   * Create a customer in DIME
   * @param {Object} customerData - Customer information
   * @param {string} tenantId - Tenant UUID
   */
  static async createCustomer(customerData, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);

      const payload = {
        data: {
          sid: config.sid,
          first_name: customerData.firstName,
          last_name: customerData.lastName,
          email: customerData.email,
          phone: customerData.phone || '7707892072',
          addr1: customerData.billingAddress || '',
          city: customerData.billingCity || '',
          state: customerData.billingState || '',
          zip: customerData.billingZip || '',
          country: customerData.billingCountry || 'USA'
        }
      };

      const response = await axios.post(
        `${config.baseUrl}/api/customer/create`,
        payload,
        { headers }
      );

      return {
        success: true,
        customerId: response.data.customer_id || response.data.data?.customer_id || response.data.data?.uuid,
        rawResponse: response.data
      };

    } catch (error) {
      // Check if email already exists - try to get existing customer
      if (error.response?.data?.errors?.['data.email']?.some(msg => msg.includes('already been taken'))) {
        const existingCustomer = await this.getCustomerByEmail(customerData.email, tenantId);
        if (existingCustomer.success) {
          return {
            success: true,
            customerId: existingCustomer.customerId,
            rawResponse: existingCustomer.rawResponse
          };
        }
      }

      return {
        success: false,
        message: error.response?.data?.message || error.message,
        error: {
          message: error.response?.data?.message || error.message,
          code: error.response?.data?.code || 'CUSTOMER_CREATION_ERROR',
          status: error.response?.status,
          details: error.response?.data?.errors || null
        }
      };
    }
  }

  /**
   * Get existing customer by email from DIME
   * Uses GET /api/customer/show with email filter
   * @param {string} email - Customer email address
   * @param {string} tenantId - Tenant UUID
   */
  static async getCustomerByEmail(email, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);

      // DIME API uses GET with data in request body (unusual but that's their format)
      // Format: GET /api/customer/show with body containing data.sid and filters.email
      const payload = {
        data: {
          sid: config.sid
        },
        filters: {
          email: email
        }
      };

      // Use axios.request() with method: 'GET' to send request body
      const response = await axios.request({
        method: 'GET',
        url: `${config.baseUrl}/api/customer/show`,
        headers,
        data: payload
      });

      // DIME API might return data in different formats
      const customerData = response.data?.data || response.data;
      
      if (customerData && customerData.uuid) {
        return {
          success: true,
          customerId: customerData.uuid,
          rawResponse: customerData
        };
      }

      return {
        success: false,
        message: 'Customer not found'
      };

    } catch (error) {
      // 404 means customer not found
      if (error.response?.status === 404) {
        return {
          success: false,
          message: 'Customer not found'
        };
      }
      
      return {
        success: false,
        message: error.response?.data?.message || error.message,
        status: error.response?.status,
        errorData: error.response?.data
      };
    }
  }

  /**
   * Verify if a customer UUID exists in DIME by attempting to list their recurring payments
   * @param {string} customerId - Customer UUID to verify
   * @param {string} tenantId - Tenant UUID
   * @returns {Promise<Object>} { success: boolean, exists: boolean, message?: string }
   */
  static async verifyCustomer(customerId, tenantId) {
    try {
      // Try to list recurring payments for this customer
      // If customer doesn't exist, this will fail with 400/404
      const result = await this.listRecurringPayments(customerId, tenantId);
      
      // If we get a response (even with no schedules), customer exists
      if (result.success || result.error?.status === 404) {
        // 404 might mean customer doesn't exist OR no schedules exist
        // But if we get a 400 with customer_uuid invalid, that's definitive
        if (result.error?.status === 400 && result.error?.data?.errors?.['filters.customer_uuid']) {
          return {
            success: true,
            exists: false,
            message: 'Customer UUID is invalid in DIME'
          };
        }
        
        // Otherwise, customer likely exists (404 might just mean no schedules)
        return {
          success: true,
          exists: true,
          message: 'Customer verified'
        };
      }
      
      return {
        success: true,
        exists: false,
        message: result.error?.message || 'Customer verification failed'
      };
    } catch (error) {
      return {
        success: false,
        exists: false,
        message: error.message || 'Failed to verify customer'
      };
    }
  }

  /**
   * Setup recurring payment schedule for group
   * @param {Object} scheduleData - Schedule configuration
   * @param {string} tenantId - Tenant UUID
   */
  static async setupRecurringPayment(scheduleData, tenantId) {
    try {
      const { customerId, paymentMethodId, amount, description, startDate } = scheduleData;
      
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);
      
      // Format dates for DIME API
      const startDateFormatted = startDate.toISOString().replace('T', ' ').substring(0, 19);
      
      // Set end date to day before next month's payment date
      // This allows the schedule to continue monthly until manually canceled
      // Example: If start is Jan 5, next payment is Feb 5, so end date is Feb 4
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 1); // Next month
      endDate.setDate(endDate.getDate() - 1); // Day before next payment
      const endDateFormatted = endDate.toISOString().replace('T', ' ').substring(0, 19);
      
      const payload = {
        data: {
          sid: config.sid,
          name: description || 'Monthly Payment',
          amount: amount,
          start_date: startDateFormatted,
          end_date: endDateFormatted,
          recurrence_schedule: 'Monthly',
          payment_method: paymentMethodId,
          customer_uuid: customerId
        }
      };
      
      const response = await axios.post(
        `${config.baseUrl}/api/recurring-payment/create`,
        payload,
        { headers }
      );
      
      const recurringPaymentId = (response.data.data?.id || response.data.id).toString();
      
      return {
        success: true,
        scheduleId: recurringPaymentId,
        nextBillingDate: startDate,
        status: 'active',
        message: 'Recurring payment schedule created and active',
        rawResponse: response.data
      };
      
    } catch (error) {
      return {
        success: false,
        error: {
          message: error.response?.data?.message || error.message,
          code: error.response?.data?.code || 'RECURRING_SETUP_ERROR',
          status: error.response?.status,
          data: error.response?.data
        }
      };
    }
  }

  /**
   * List all recurring payment schedules for a customer in DIME
   * @param {string} customerId - DIME customer UUID
   * @param {string} tenantId - Tenant UUID
   * @returns {Promise<Array>} Array of schedule objects with id, amount, status, etc.
   */
  /**
   * @param {string} customerId - DIME customer_uuid (e.g. group ProcessorCustomerId)
   * @param {string} tenantId - Tenant UUID
   * @param {{ status?: string }} opts - optional filters; status e.g. "Active, Failed, Paused, Canceled" to include failed
   */
  static async listRecurringPayments(customerId, tenantId, opts = {}) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);

      const filters = { customer_uuid: customerId };
      if (opts.status) filters.status = opts.status;

      // DIME API uses GET with data in request body (unusual but that's their format)
      // Format: GET /api/recurring-payment/list with body containing data.sid and filters (customer_uuid, status)
      const response = await axios.request({
        method: 'GET',
        url: `${config.baseUrl}/api/recurring-payment/list`,
        headers,
        data: {
          data: {
            sid: config.sid
          },
          filters
        }
      });
      
      // DIME API might return data in different formats
      const schedules = response.data?.data || response.data?.recurring_payments || response.data || [];
      
      return {
        success: true,
        schedules: Array.isArray(schedules) ? schedules : [],
        rawResponse: response.data
      };
    } catch (error) {
      // 404 "No recurring payments found" is normal when customer has no (or no Failed) schedules
      const is404NoRecurring = error.response?.status === 404 &&
        (error.response?.data?.data?.message === 'No recurring payments found' ||
         error.response?.data?.message === 'No recurring payments found');
      if (is404NoRecurring) {
        return { success: true, schedules: [] };
      }
      // Log other errors
      console.error('DIME listRecurringPayments error:', {
        status: error.response?.status,
        message: error.response?.data?.message || error.message,
        data: error.response?.data
      });
      // Other 404 (e.g. endpoint not exist) return empty
      if (error.response?.status === 404) {
        return {
          success: false,
          schedules: [],
          message: 'DIME list endpoint returned 404 - endpoint may not exist',
          error: {
            message: 'Endpoint not found',
            status: 404
          }
        };
      }
      
      return {
        success: false,
        schedules: [],
        error: {
          message: error.response?.data?.message || error.message,
          code: error.response?.data?.code || 'LIST_SCHEDULES_ERROR',
          status: error.response?.status,
          details: error.response?.data
        }
      };
    }
  }

  /**
   * Cancel a recurring payment schedule in DIME
   * @param {string} scheduleId - DIME recurring payment ID
   * @param {string} tenantId - Tenant UUID
   */
  static async cancelRecurringPayment(scheduleId, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);
      
      // DIME API uses PATCH /api/recurring-payment/cancel with data.recurring_payment_id
      const response = await axios.patch(
        `${config.baseUrl}/api/recurring-payment/cancel`,
        {
          data: {
            sid: config.sid,
            recurring_payment_id: scheduleId
          }
        },
        { headers }
      );
      
      return {
        success: true,
        message: 'Recurring payment schedule canceled',
        data: response.data
      };
    } catch (error) {
      // 404 means already canceled - treat as success
      if (error.response?.status === 404) {
        return {
          success: true,
          message: 'Schedule already canceled or not found',
          wasAlreadyCanceled: true
        };
      }
      
      throw error;
    }
  }

  /**
   * Update an existing recurring payment schedule
   * NOTE: DIME doesn't have a direct update endpoint, so we cancel and recreate
   * @param {Object} updateData - Schedule update configuration
   * @param {string} tenantId - Tenant UUID
   */
  static async updateRecurringPayment(updateData, tenantId) {
    try {
      const { scheduleId, customerId, paymentMethodId, amount, startDate, description } = updateData;
      
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);
      
      // Step 1: Cancel existing schedule
      try {
        await axios.patch(
          `${config.baseUrl}/api/recurring-payment/cancel`,
          {
            data: {
              sid: config.sid,
              recurring_payment_id: scheduleId
            }
          },
          { headers }
        );
      } catch (cancelError) {
        // Continue if schedule not found (might already be canceled)
        if (cancelError.response?.status !== 404) {
          console.warn('Failed to cancel existing schedule:', cancelError.response?.data);
        }
      }
      
      // Step 2: Create new schedule with updated amount
      const newSchedule = await this.setupRecurringPayment({
        customerId,
        paymentMethodId,
        amount,
        description: description || 'Monthly Payment',
        startDate: startDate || new Date()
      }, tenantId);
      
      if (!newSchedule.success) {
        throw new Error(`Failed to create new recurring payment: ${newSchedule.message}`);
      }
      
      return {
        success: true,
        scheduleId: newSchedule.scheduleId,
        amount,
        nextBillingDate: newSchedule.nextBillingDate,
        message: 'Recurring payment schedule updated (canceled and recreated)'
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.response?.data || error.message,
        message: 'Failed to update recurring payment schedule'
      };
    }
  }

  /**
   * Charge a payment method directly (one-time payment)
   * Used for processing invoice payments on the 5th of the month
   * @param {Object} chargeData - Charge data with customerId, paymentMethodId, amount, description, metadata
   * @param {string} tenantId - Tenant UUID
   * @returns {Promise<Object>} Result with success, transactionId, or error
   */
  static async chargePaymentMethod(chargeData, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);

      const { customerId, paymentMethodId, amount, description, metadata } = chargeData;

      if (!customerId || !paymentMethodId || !amount) {
        throw new Error('Missing required fields: customerId, paymentMethodId, and amount are required');
      }

      // Determine payment method type from payment method ID or metadata
      // For now, we'll need to get this from the database or pass it in
      // Defaulting to Card for now - this should be passed in or retrieved
      const paymentMethodType = chargeData.paymentMethodType || 'Card';

      const endpoint = paymentMethodType === 'ACH' 
        ? '/api/transaction/charge-ach' 
        : '/api/transaction/charge-card';

      const payload = {
        data: {
          sid: config.sid,
          amount: amount,
          customer_uuid: customerId,
          payment_method_id: paymentMethodId, // Use stored payment method ID
          memo: (description || 'Invoice payment').replace(/[^a-zA-Z0-9\s,.\-']/g, '')
        }
      };

      // DIME requires cardholder_name for credit cards when using payment_method_id
      if (paymentMethodType === 'Card' || paymentMethodType === 'CreditCard') {
        if (chargeData.cardholderName) {
          payload.data.cardholder_name = chargeData.cardholderName;
        }
      }

      // Add metadata if provided
      if (metadata) {
        payload.data.metadata = metadata;
      }

      const response = await axios.post(
        `${config.baseUrl}${endpoint}`,
        payload,
        { headers }
      );

      const transactionId = response.data.data?.transaction_id || response.data.data?.id || response.data.transaction_id;

      return {
        success: true,
        transactionId: transactionId?.toString(),
        message: 'Payment processed successfully'
      };

    } catch (error) {
      console.error('Error charging payment method:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data || error.message,
        message: 'Failed to charge payment method'
      };
    }
  }

  /**
   * List recent transactions for a tenant (merchant-level). Does NOT filter by customer.
   * Use this for payment sync: one call per tenant returns all transactions in the date range;
   * each transaction should include customer_uuid (or equivalent) so we can match to our groups.
   * @param {Object} filters - { start_date, end_date } (optional: sweep_id)
   * @param {string} tenantId - Tenant UUID
   * @returns {Promise<Object>} Result with success, transactions array, or error
   */
  static async listRecentTransactions(filters, tenantId) {
    const { start_date, end_date, sweep_id } = filters || {};
    return this.listTransactions(
      { start_date, end_date, sweep_id },
      tenantId
    );
  }

  /**
   * List transactions from DIME API
   * @param {Object} filters - Filter options (start_date, end_date, customer_uuid, sweep_id)
   * @param {string} tenantId - Tenant UUID
   * @returns {Promise<Object>} Result with success, transactions array, or error
   */
  static async listTransactions(filters, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);

      // Build filters object
      const filterObj = {
        data: {
          sid: config.sid
        },
        filters: {}
      };

      // Add optional filters
      if (filters.start_date) {
        filterObj.filters.start_date = filters.start_date;
      }
      if (filters.end_date) {
        filterObj.filters.end_date = filters.end_date;
      }
      if (filters.customer_uuid) {
        filterObj.filters.customer_uuid = filters.customer_uuid;
      }
      if (filters.sweep_id) {
        filterObj.filters.sweep_id = filters.sweep_id;
      }

      // DIME API uses GET with data in request body (unusual but that's their format)
      const response = await axios.request({
        method: 'GET',
        url: `${config.baseUrl}/api/transactions`,
        headers,
        data: filterObj
      });

      // DIME API returns { data: [ { transaction_number, transaction_info_id, amount, transaction_status, customer_uuid, ... } ] }
      const transactions = response.data?.data || response.data?.transactions || response.data || [];

      return {
        success: true,
        transactions: Array.isArray(transactions) ? transactions : [],
        rawResponse: response.data
      };
    } catch (error) {
      console.error('DIME listTransactions error:', {
        status: error.response?.status,
        message: error.response?.data?.message || error.message,
        data: error.response?.data
      });

      // 404 with "No transactions found" is a valid empty result (endpoint exists, just no data)
      if (error.response?.status === 404) {
        const bodyMsg = (error.response?.data?.data?.message || error.response?.data?.message || '').toString().toLowerCase();
        if (bodyMsg.includes('no transactions found') || bodyMsg.includes('no transactions')) {
          return {
            success: true,
            transactions: [],
            message: 'No transactions found in date range'
          };
        }
        return {
          success: false,
          transactions: [],
          message: 'DIME transactions endpoint returned 404 - endpoint may not exist',
          error: {
            message: 'Endpoint not found',
            status: 404
          }
        };
      }

      return {
        success: false,
        transactions: [],
        error: {
          message: error.response?.data?.message || error.message,
          code: error.response?.data?.code || 'LIST_TRANSACTIONS_ERROR',
          status: error.response?.status,
          details: error.response?.data
        }
      };
    }
  }

  /**
   * GET /api/transaction (body on GET) — same contract as backend DimeService.
   * @param {string} tenantId
   * @param {string} transactionId
   * @param {string} transactionType 'ACH' | 'CC'
   * @param {{ transactionInfoId?: string|null }} [options]
   */
  static async getTransaction(tenantId, transactionId, transactionType, options = {}) {
    if (!tenantId || !transactionId || !transactionType) {
      return { success: false, error: { message: 'tenantId, transactionId and transactionType are required' } };
    }
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);
      const payload = {
        data: {
          sid: config.sid,
          transaction_id: String(transactionId).trim(),
          transaction_type: transactionType === 'ACH' ? 'ACH' : 'CC'
        }
      };
      const tid =
        options.transactionInfoId != null && String(options.transactionInfoId).trim() !== ''
          ? String(options.transactionInfoId).trim()
          : null;
      if (tid) {
        payload.data.transaction_info_id = tid;
      }
      const response = await axios.request({
        method: 'GET',
        url: `${config.baseUrl}/api/transaction`,
        headers,
        data: payload
      });
      const data = response.data?.data || response.data;
      const transactionInfoId = data?.transaction_info_id != null ? String(data.transaction_info_id) : null;
      return {
        success: true,
        transactionInfoId,
        data: data && typeof data === 'object' ? data : null,
        rawResponse: response.data
      };
    } catch (error) {
      return {
        success: false,
        error: {
          message: error.response?.data?.message || error.message,
          status: error.response?.status,
          details: error.response?.data
        }
      };
    }
  }

  /**
   * Resolve a transaction for admin audit: try CC vs ACH when ambiguous, then GET /api/transactions/:id.
   * Mirrors backend/services/dimeService.getTransactionForAudit.
   */
  static async getTransactionForAudit(tenantId, transactionId, paymentMethod, transactionInfoId = null) {
    const pm = String(paymentMethod || '').toLowerCase();
    const infoId =
      transactionInfoId != null && String(transactionInfoId).trim() !== ''
        ? String(transactionInfoId).trim()
        : null;

    let types;
    if (pm.includes('ach') || pm.includes('bank') || pm.includes('checking') || pm.includes('savings')) {
      types = ['ACH'];
    } else if (pm.includes('recurring')) {
      types = ['ACH', 'CC'];
    } else if (pm.includes('card') || pm.includes('cc') || pm.includes('credit') || pm.includes('debit')) {
      types = ['CC'];
    } else {
      types = ['CC', 'ACH'];
    }

    const attemptedTypes = [];
    for (const txType of types) {
      attemptedTypes.push(txType);
      const r = await this.getTransaction(tenantId, transactionId, txType, { transactionInfoId: infoId });
      if (r.success) {
        return { ...r, attemptedTypes, source: 'GET /api/transaction' };
      }
      const st = r.error && r.error.status;
      if (st != null && st !== 404) {
        return { ...r, attemptedTypes };
      }
    }

    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);
      const tid = encodeURIComponent(String(transactionId).trim());
      const response = await axios.get(`${config.baseUrl}/api/transactions/${tid}`, { headers });
      const data = response.data?.data || response.data;
      if (data && typeof data === 'object') {
        return {
          success: true,
          data,
          rawResponse: response.data,
          attemptedTypes,
          source: 'GET /api/transactions/:id'
        };
      }
    } catch (e) {
      const st = e.response && e.response.status;
      if (st != null && st !== 404) {
        return {
          success: false,
          error: {
            message: (e.response.data && e.response.data.message) || e.message,
            status: st,
            details: e.response.data
          },
          attemptedTypes
        };
      }
    }

    return {
      success: false,
      error: {
        message: 'No transaction found',
        status: 404,
        details: null
      },
      attemptedTypes
    };
  }
}

module.exports = DimeService;

