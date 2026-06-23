const { getPool, sql } = require('../config/database');
const DimeService = require('./dimeService');
const NmiService  = require('./nmiService');

/**
 * Returns the correct payment service class for a given tenant,
 * based on the tenant's activeProcessor setting in PaymentProcessorSettings.
 *
 * Usage:
 *   const service = await getPaymentService(tenantId);
 *   const result  = await service.processPayment(paymentData, tenantId);
 *
 * @param {string} tenantId
 * @returns {typeof DimeService | typeof NmiService}
 */
async function getPaymentService(tenantId) {
    if (!tenantId) throw new Error('getPaymentService: tenantId is required');

    const pool = await getPool();
    const result = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query('SELECT PaymentProcessorSettings FROM oe.Tenants WHERE TenantId = @tenantId');

    if (!result.recordset.length || !result.recordset[0].PaymentProcessorSettings) {
        throw new Error(`No PaymentProcessorSettings found for tenant ${tenantId}`);
    }

    const settings = JSON.parse(result.recordset[0].PaymentProcessorSettings);

    switch (settings.activeProcessor) {
        case 'openenroll': return DimeService;
        case 'nmi':        return NmiService;
        default:
            throw new Error(`Unknown payment processor: ${settings.activeProcessor}`);
    }
}

module.exports = { getPaymentService };