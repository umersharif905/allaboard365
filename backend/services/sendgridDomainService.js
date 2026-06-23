// backend/services/sendgridDomainService.js
const axios = require('axios');

class SendGridDomainService {
  constructor() {
    this.baseUrl = 'https://api.sendgrid.com/v3';
    this.apiKey = process.env.SENDGRID_API_KEY;
    
    if (!this.apiKey) {
      console.warn('⚠️  SENDGRID_API_KEY is not configured - domain authentication will be disabled');
      this.isEnabled = false;
    } else {
      console.log('✅ SendGrid Domain Service initialized successfully');
      this.isEnabled = true;
    }
  }

  /**
   * Create domain authentication in SendGrid
   * @param {string} domain - The domain to authenticate
   * @param {string} subdomain - The subdomain (default: 'em')
   * @returns {Promise<Object>} SendGrid response with domain ID and DNS records
   */
  async createDomainAuthentication(domain, subdomain = 'em') {
    if (!this.isEnabled) {
      throw new Error('SendGrid API key not configured');
    }

    try {
      console.log(`🔧 Creating domain authentication for: ${domain}`);
      
      const response = await axios.post(`${this.baseUrl}/whitelabel/domains`, {
        domain,
        subdomain,
        automatic_security: true,
        custom_spf: true
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      console.log(`✅ Domain authentication created successfully for: ${domain}`);
      return response.data;
    } catch (error) {
      console.error('❌ Error creating domain authentication:', error.response?.data || error.message);
      throw new Error(`Failed to create domain authentication: ${error.response?.data?.errors?.[0]?.message || error.message}`);
    }
  }

  /**
   * Validate domain authentication in SendGrid
   * @param {string} domainId - The SendGrid domain ID
   * @returns {Promise<Object>} Validation result
   */
  async validateDomainAuthentication(domainId) {
    if (!this.isEnabled) {
      throw new Error('SendGrid API key not configured');
    }

    try {
      console.log(`🔧 Validating domain authentication for ID: ${domainId}`);
      
      const response = await axios.post(`${this.baseUrl}/whitelabel/domains/${domainId}/validate`, {}, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      console.log(`✅ Domain authentication validation completed for ID: ${domainId}`);
      return response.data;
    } catch (error) {
      console.error('❌ Error validating domain authentication:', error.response?.data || error.message);
      throw new Error(`Failed to validate domain authentication: ${error.response?.data?.errors?.[0]?.message || error.message}`);
    }
  }

  /**
   * Get domain authentication details from SendGrid
   * @param {string} domainId - The SendGrid domain ID
   * @returns {Promise<Object>} Domain details and DNS records
   */
  async getDomainAuthentication(domainId) {
    if (!this.isEnabled) {
      throw new Error('SendGrid API key not configured');
    }

    try {
      console.log(`🔧 Getting domain authentication details for ID: ${domainId}`);
      
      const response = await axios.get(`${this.baseUrl}/whitelabel/domains/${domainId}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      console.log(`✅ Domain authentication details retrieved for ID: ${domainId}`);
      return response.data;
    } catch (error) {
      console.error('❌ Error getting domain authentication:', error.response?.data || error.message);
      throw new Error(`Failed to get domain authentication: ${error.response?.data?.errors?.[0]?.message || error.message}`);
    }
  }

  /**
   * Delete domain authentication from SendGrid
   * @param {string} domainId - The SendGrid domain ID
   * @returns {Promise<Object>} Deletion result
   */
  async deleteDomainAuthentication(domainId) {
    if (!this.isEnabled) {
      throw new Error('SendGrid API key not configured');
    }

    try {
      console.log(`🔧 Deleting domain authentication for ID: ${domainId}`);
      
      const response = await axios.delete(`${this.baseUrl}/whitelabel/domains/${domainId}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      console.log(`✅ Domain authentication deleted successfully for ID: ${domainId}`);
      return response.data;
    } catch (error) {
      console.error('❌ Error deleting domain authentication:', error.response?.data || error.message);
      throw new Error(`Failed to delete domain authentication: ${error.response?.data?.errors?.[0]?.message || error.message}`);
    }
  }

  /**
   * List all domain authentications for the account
   * @returns {Promise<Array>} List of domains
   */
  async listDomainAuthentications() {
    if (!this.isEnabled) {
      throw new Error('SendGrid API key not configured');
    }

    try {
      console.log(`🔧 Listing all domain authentications`);
      
      const response = await axios.get(`${this.baseUrl}/whitelabel/domains`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      console.log(`✅ Retrieved ${response.data?.length || 0} domain authentications`);
      return response.data;
    } catch (error) {
      console.error('❌ Error listing domain authentications:', error.response?.data || error.message);
      throw new Error(`Failed to list domain authentications: ${error.response?.data?.errors?.[0]?.message || error.message}`);
    }
  }

  /**
   * Extract DNS records from SendGrid response
   * @param {Object} sendgridResponse - SendGrid domain authentication response
   * @returns {Array} Formatted DNS records
   */
  extractDnsRecords(sendgridResponse) {
    const records = [];
    
    if (sendgridResponse.dns) {
      // Process all DNS records from SendGrid response
      Object.entries(sendgridResponse.dns).forEach(([key, record]) => {
        if (record && typeof record === 'object' && record.host && record.data) {
          records.push({
            type: record.type || 'CNAME', // Default to CNAME if type not specified
            host: record.host,
            value: record.data,
            status: record.valid ? 'verified' : 'pending',
            key: key // Store the original key for reference
          });
        }
      });
    }
    
    console.log(`📋 Extracted ${records.length} DNS records:`, records);
    return records;
  }

  /**
   * Check if service is enabled
   * @returns {boolean} Service status
   */
  isServiceEnabled() {
    return this.isEnabled;
  }
}

// Export both the class and an instance
const serviceInstance = new SendGridDomainService();

// Ensure methods are bound to the instance
serviceInstance.createDomainAuthentication = serviceInstance.createDomainAuthentication.bind(serviceInstance);
serviceInstance.validateDomainAuthentication = serviceInstance.validateDomainAuthentication.bind(serviceInstance);
serviceInstance.getDomainAuthentication = serviceInstance.getDomainAuthentication.bind(serviceInstance);
serviceInstance.deleteDomainAuthentication = serviceInstance.deleteDomainAuthentication.bind(serviceInstance);
serviceInstance.isServiceEnabled = serviceInstance.isServiceEnabled.bind(serviceInstance);
serviceInstance.extractDnsRecords = serviceInstance.extractDnsRecords.bind(serviceInstance);

module.exports = serviceInstance;
