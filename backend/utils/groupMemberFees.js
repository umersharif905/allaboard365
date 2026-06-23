/**
 * Group member fee helpers: system fee + payment processing fee for a given premium.
 * Used for contribution calculations (actual premium and equivalent-tier base including fees).
 */

const sql = require('mssql');

/**
 * Get TenantId for a group.
 * @param {string} groupId - Group ID
 * @param {Object} pool - SQL connection pool
 * @returns {Promise<string|null>} TenantId or null
 */
async function getTenantIdForGroup(groupId, pool) {
  if (!groupId || !pool) return null;
  try {
    const request = pool.request();
    request.input('groupId', sql.UniqueIdentifier, groupId);
    const result = await request.query(`
      SELECT TenantId FROM oe.Groups WHERE GroupId = @groupId
    `);
    return result.recordset.length > 0 ? result.recordset[0].TenantId : null;
  } catch (e) {
    console.warn('groupMemberFees.getTenantIdForGroup failed', e.message);
    return null;
  }
}

/**
 * Calculate additional fees (system + processing) for a given premium amount.
 * Used for actual member total and for equivalent-tier base (e.g. fees on EE-equivalent product total).
 *
 * When `basePremiumByProductId` is provided, per-product fee flags are honored — specifically
 * ZeroFeeForACH products contribute $0 to the processing fee under ACH. When omitted, legacy
 * flat-premium math is used (backward compatible).
 *
 * @param {string} groupId - Group ID (for payment method)
 * @param {string} tenantId - Tenant ID (for SystemFees and PaymentProcessorSettings)
 * @param {number} totalPremium - Premium amount to calculate fees on
 * @param {Object} pool - SQL connection pool
 * @param {Map<string, number>} [basePremiumByProductId] - Optional per-product premium map for ZeroFeeForACH-aware math
 * @returns {Promise<number>} Total fees (system + processing)
 */
async function getAdditionalFeesForMember(groupId, tenantId, totalPremium, pool, basePremiumByProductId = null) {
  let additionalFees = 0;
  try {
    if (!tenantId || !pool) return 0;
    const request = pool.request();
    request.input('tenantId', sql.UniqueIdentifier, tenantId);
    const tenantResult = await request.query(`
      SELECT PaymentProcessorSettings, SystemFees FROM oe.Tenants WHERE TenantId = @tenantId
    `);
    if (tenantResult.recordset.length === 0) return 0;
    const row = tenantResult.recordset[0];
    let paymentProcessorSettings = null;
    let systemFeesSettings = null;
    if (row.PaymentProcessorSettings) {
      try {
        paymentProcessorSettings = JSON.parse(row.PaymentProcessorSettings);
      } catch (_) {}
    }
    if (row.SystemFees) {
      try {
        systemFeesSettings = JSON.parse(row.SystemFees);
      } catch (_) {}
    }
    const systemFeesCalculator = require('./systemFeesCalculator');
    const systemFeesAmount = systemFeesCalculator.calculateSystemFees(totalPremium, systemFeesSettings);
    let groupPaymentMethod = 'ACH';
    const gmRequest = pool.request();
    gmRequest.input('groupId', sql.UniqueIdentifier, groupId);
    const gpmResult = await gmRequest.query(`
      SELECT TOP 1 Type FROM oe.GroupPaymentMethods
      WHERE GroupId = @groupId AND Status = 'Active' ORDER BY IsDefault DESC, CreatedDate DESC
    `);
    if (gpmResult.recordset.length > 0) {
      groupPaymentMethod = gpmResult.recordset[0].Type === 'CreditCard' ? 'Card' : 'ACH';
    }
    const processingFeeCalculator = require('./processingFeeCalculator');

    let paymentProcessingFeeAmount = 0;
    if (paymentProcessorSettings?.chargeFeeToMember) {
      if (basePremiumByProductId && basePremiumByProductId.size > 0) {
        // ZeroFeeForACH-aware path via pricingAuthority (single source of truth).
        const pricingAuthority = require('../services/pricing/pricingAuthority.service');
        const pricingProducts = Array.from(basePremiumByProductId.entries()).map(([productId, monthlyPremium]) => ({
          productId,
          monthlyPremium: Number(monthlyPremium || 0)
        }));
        const authorityOutput = await pricingAuthority.computePricing({
          poolOrTransaction: pool,
          tenantId,
          pricingProducts,
          paymentMethodType: groupPaymentMethod
        });
        paymentProcessingFeeAmount = Number(authorityOutput.totals.nonIncludedFeeTotal || 0) + Number(authorityOutput.totals.includedFeeTotal || 0);
      } else {
        paymentProcessingFeeAmount = processingFeeCalculator.calculateProcessingFee(totalPremium, groupPaymentMethod, paymentProcessorSettings);
      }
    }
    additionalFees = systemFeesAmount + paymentProcessingFeeAmount;
  } catch (e) {
    console.warn('groupMemberFees.getAdditionalFeesForMember failed', e.message);
  }
  return additionalFees;
}

module.exports = {
  getTenantIdForGroup,
  getAdditionalFeesForMember
};
