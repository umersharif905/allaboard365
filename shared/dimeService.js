const axios = require('axios');

/**
 * DIME Payments Service - Azure Functions Edition
 * Focused on recurring payment schedule management
 */
class DimeService {
  /**
   * Get DIME configuration based on environment
   */
  static getConfig() {
    const isProduction = process.env.NODE_ENV === 'production';
    
    return {
      apiToken: isProduction 
        ? process.env.DIME_PROD_API_TOKEN 
        : process.env.DIME_DEMO_API_TOKEN,
      sid: isProduction 
        ? process.env.DIME_PROD_SID 
        : process.env.DIME_DEMO_SID,
      baseUrl: isProduction 
        ? process.env.DIME_PROD_API_BASE_URL 
        : process.env.DIME_DEMO_API_BASE_URL
    };
  }

  /**
   * Create authenticated request headers
   */
  static getHeaders() {
    const config = this.getConfig();
    return {
      'Authorization': `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  /**
   * Create a customer in DIME
   */
  static async createCustomer(customerData) {
    try {
      const config = this.getConfig();
      const headers = this.getHeaders();

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
        const existingCustomer = await this.getCustomerByEmail(customerData.email);
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
   */
  static async getCustomerByEmail(email) {
    try {
      const config = this.getConfig();
      const headers = this.getHeaders();

      const payload = {
        filters: { email },
        data: { sid: config.sid }
      };

      const response = await axios.patch(
        `${config.baseUrl}/api/customer/update`,
        payload,
        { headers }
      );

      if (response.data && response.data.data) {
        return {
          success: true,
          customerId: response.data.data.uuid,
          rawResponse: response.data.data
        };
      }

      return {
        success: false,
        message: 'Customer not found'
      };

    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Setup recurring payment schedule for group
   */
  static async setupRecurringPayment(scheduleData) {
    try {
      const { customerId, paymentMethodId, amount, description, startDate } = scheduleData;
      
      const config = this.getConfig();
      const headers = this.getHeaders();
      
      // Calculate end date (1st of following month)
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 1);
      endDate.setDate(1);
      
      // Format dates for DIME API
      const startDateFormatted = startDate.toISOString().replace('T', ' ').substring(0, 19);
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
   * Cancel a recurring payment schedule in DIME
   */
  static async cancelRecurringPayment(scheduleId) {
    try {
      const config = this.getConfig();
      const headers = this.getHeaders();
      
      const response = await axios.post(
        `${config.baseUrl}/api/recurring-payment/${scheduleId}/cancel`,
        { data: { sid: config.sid } },
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
   */
  static async updateRecurringPayment(updateData) {
    try {
      const { scheduleId, customerId, paymentMethodId, amount, startDate, description } = updateData;
      
      const config = this.getConfig();
      const headers = this.getHeaders();
      
      // Step 1: Cancel existing schedule
      try {
        await axios.post(
          `${config.baseUrl}/api/recurring-payment/${scheduleId}/cancel`,
          { data: { sid: config.sid } },
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
      });
      
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
}

module.exports = DimeService;

