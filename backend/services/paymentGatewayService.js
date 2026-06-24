const DimeService = require('./dimeService');
const NmiService = require('./nmiService');
const { getPool, sql } = require('../config/database');

class PaymentGatewayService {

  /**
   * Read Tenants.PaymentProcessorSettings.activeProcessor.
   * Returns 'openenroll' (DIME) or 'nmi'. Defaults to 'openenroll' on
   * missing/malformed settings so existing DIME tenants are unaffected.
   */
  static async getActiveProcessor(tenantId) {
    if (!tenantId) {
      throw new Error('PaymentGatewayService.getActiveProcessor: tenantId is required');
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query('SELECT PaymentProcessorSettings FROM oe.Tenants WHERE TenantId = @tenantId');

    if (!result.recordset.length) {
      throw new Error(`PaymentGatewayService: Tenant ${tenantId} not found`);
    }

    const raw = result.recordset[0].PaymentProcessorSettings;
    if (!raw) return 'openenroll';

    let settings;
    try {
      settings = JSON.parse(raw);
    } catch (e) {
      console.error('❌ PaymentGatewayService: failed to parse PaymentProcessorSettings', e.message);
      return 'openenroll';
    }

    return settings.activeProcessor || 'openenroll';
  }

  /** Returns the service CLASS (DimeService or NmiService) for a tenant. */
  static async getServiceForTenant(tenantId) {
    const processor = await this.getActiveProcessor(tenantId);
    return processor === 'nmi' ? NmiService : DimeService;
  }

  static async processPayment(paymentData, tenantId) {
    const Service = await this.getServiceForTenant(tenantId);
    console.log('💳 PaymentGatewayService.processPayment using:', Service === NmiService ? 'NMI' : 'DIME');
    return Service.processPayment(paymentData, tenantId);
  }

  static async refundTransaction(transactionId, amount, tenantId, paymentMethod) {
    const Service = await this.getServiceForTenant(tenantId);
    if (Service === NmiService) {
      // NmiService.refundTransaction signature: (transactionId, amount, tenantId)
      return NmiService.refundTransaction(transactionId, amount, tenantId);
    }
    return DimeService.refundTransaction(transactionId, amount, tenantId, paymentMethod);
  }
}

module.exports = PaymentGatewayService;