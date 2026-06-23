/**
 * Processing Fee Calculator Utility
 *
 * Single entry point: calculateProcessingFee(amount, paymentMethod, tenantSettings, options).
 * - paymentMethod 'ACH' | 'Card': fee for that method (e.g. non-included premium, known payment method).
 * - paymentMethod 'Highest': higher of ACH vs Card (for included-fee display so one price covers either method).
 * Product config (IncludeProcessingFee, RoundUpProcessingFee) is handled by callers (e.g. includedProcessingFee.js);
 * this module only computes the fee amount from amount + method (or 'Highest').
 *
 * Backward compatibility: calculateHighestProcessingFee(amount, tenantSettings, options) is unchanged (same return
 * { paymentMethod, processingFee }). For paymentMethod, only 'ACH' (case-insensitive) uses ACH fees; all other
 * values (including 'Card', 'CreditCard', undefined) use Card, matching original behavior.
 */

const DEBUG_PRICING =
  process.env.DEBUG_PRICING === 'true' ||
  process.env.DEBUG_PRICING === '1' ||
  String(process.env.DEBUG_PRICING || '').toLowerCase() === 'yes';

/** Normalized payment method for internal fee lookup: 'ACH' | 'Card' */
const PAYMENT_METHOD_ACH = 'ACH';
const PAYMENT_METHOD_CARD = 'Card';
/** Use when the product "includes" processing fee: fee = higher of ACH and Card so one price covers either method. */
const PAYMENT_METHOD_HIGHEST = 'Highest';

/**
 * Calculate processing fee for a payment.
 * One function for both "regular" (known method) and "included" (Highest) cases; caller passes method or 'Highest' based on context.
 * @param {number} amount - Base payment amount (premium)
 * @param {string} paymentMethod - 'ACH' | 'Card' (fee for that method) or 'Highest' (for included-fee display: max of ACH and Card)
 * @param {Object} tenantSettings - Tenant's PaymentProcessorSettings (parsed from JSON)
 * @param {Object} [options] - Optional settings
 * @param {boolean} [options.roundUp=true] - When true, always round UP to nearest cent. When false, normal round to nearest cent.
 * @param {boolean} [options.ignoreChargeFeeToMember=false] - When true, calculates even if chargeFeeToMember is false (useful for display only).
 * @returns {number} Processing fee amount (rounded to 2 decimals)
 */
function calculateProcessingFee(amount, paymentMethod, tenantSettings, options = {}) {
  const { roundUp = true, ignoreChargeFeeToMember = false } = options;
  if (!ignoreChargeFeeToMember && (!tenantSettings || !tenantSettings.chargeFeeToMember)) {
    return 0;
  }

  const useHighest = paymentMethod === PAYMENT_METHOD_HIGHEST || String(paymentMethod).toLowerCase() === 'highest';
  if (useHighest) {
    const achFee = calculateProcessingFeeForMethod(amount, PAYMENT_METHOD_ACH, tenantSettings, options);
    const cardFee = calculateProcessingFeeForMethod(amount, PAYMENT_METHOD_CARD, tenantSettings, options);
    const totalFee = Math.max(achFee, cardFee);
    if (DEBUG_PRICING) {
      console.log(`💳 Processing fee calculation (Highest):`, {
        amount: `$${Number(amount).toFixed(2)}`,
        paymentMethod: 'Highest',
        achFee: `$${achFee.toFixed(2)}`,
        cardFee: `$${cardFee.toFixed(2)}`,
        totalFee: `$${totalFee.toFixed(2)}`
      });
    }
    return totalFee;
  }

  // Preserve original behavior: only 'ACH' uses ACH fees; everything else (including 'Card', 'CreditCard', undefined) uses Card
  const method = String(paymentMethod).toLowerCase() === 'ach' ? PAYMENT_METHOD_ACH : PAYMENT_METHOD_CARD;
  return calculateProcessingFeeForMethod(amount, method, tenantSettings, options);
}

/**
 * Internal: fee for a single method (ACH or Card). Used by calculateProcessingFee and calculateHighestProcessingFee.
 */
function calculateProcessingFeeForMethod(amount, paymentMethod, tenantSettings, options = {}) {
  const { roundUp = true, ignoreChargeFeeToMember = false } = options;
  if (!ignoreChargeFeeToMember && (!tenantSettings || !tenantSettings.chargeFeeToMember)) {
    return 0;
  }

  const processors = tenantSettings?.processors || {};
  const activeKey = tenantSettings?.activeProcessor ? String(tenantSettings.activeProcessor) : null;
  const activeProcessor = activeKey && processors ? processors[activeKey] : null;
  const fallbackProcessor = processors?.openenroll || null;
  const processorToUse = activeProcessor || fallbackProcessor;
  const feeConfig = paymentMethod === PAYMENT_METHOD_ACH
    ? processorToUse?.fees?.ach
    : processorToUse?.fees?.creditCard;

  if (!feeConfig) {
    console.warn(`⚠️ No fee configuration found for payment method: ${paymentMethod}`);
    return 0;
  }

  const rawPercentageFee = feeConfig.percentageFee || 0;
  const normalizedPercentageFee = rawPercentageFee > 1 ? rawPercentageFee / 100 : rawPercentageFee;
  const percentageFee = amount * normalizedPercentageFee;
  const flatFee = feeConfig.flatFee || 0;
  const rawTotal = percentageFee + flatFee;
  const totalFee = roundUp ? (Math.ceil(rawTotal * 100) / 100) : (Math.round(rawTotal * 100) / 100);
  const displayPercentage = rawPercentageFee > 1 ? rawPercentageFee : (rawPercentageFee * 100);

  if (DEBUG_PRICING) {
    console.log(`💳 Processing fee calculation:`, {
      amount: `$${Number(amount).toFixed(2)}`,
      paymentMethod,
      percentageFee: `${displayPercentage.toFixed(2)}%`,
      flatFee: `$${Number(flatFee).toFixed(2)}`,
      calculatedPercentageFee: `$${percentageFee.toFixed(2)}`,
      totalFee: `$${totalFee.toFixed(2)}`
    });
  }

  return totalFee;
}

/**
 * Calculate the highest processing fee between ACH and Card for a given amount.
 * @deprecated Use calculateProcessingFee(amount, 'Highest', tenantSettings, options) instead. This helper is kept for
 *   backward compatibility; it returns { paymentMethod, processingFee } for callers that need the method. New code
 *   should use the single entry point with paymentMethod 'Highest'.
 */
function calculateHighestProcessingFee(amount, tenantSettings, options = {}) {
  const achFee = calculateProcessingFeeForMethod(amount, PAYMENT_METHOD_ACH, tenantSettings, options);
  const cardFee = calculateProcessingFeeForMethod(amount, PAYMENT_METHOD_CARD, tenantSettings, options);
  if (cardFee >= achFee) {
    return { paymentMethod: PAYMENT_METHOD_CARD, processingFee: cardFee };
  }
  return { paymentMethod: PAYMENT_METHOD_ACH, processingFee: achFee };
}

/**
 * Calculate total payment amount including processing fee
 * @param {number} premiumAmount - Base premium amount
 * @param {string} paymentMethod - Payment method type: 'ACH' or 'Card'
 * @param {Object} tenantSettings - Tenant's PaymentProcessorSettings
 * @returns {Object} Payment breakdown { premiumAmount, processingFee, totalAmount }
 */
function calculateTotalWithProcessingFee(premiumAmount, paymentMethod, tenantSettings) {
  const processingFee = calculateProcessingFee(premiumAmount, paymentMethod, tenantSettings);
  const totalAmount = Math.round((premiumAmount + processingFee) * 100) / 100;

  return {
    premiumAmount,
    processingFee,
    totalAmount
  };
}

/**
 * Get default fee configuration (fallback when tenant hasn't configured fees)
 * @returns {Object} Default fee configuration
 */
function getDefaultFeeConfig() {
  return {
    ach: {
      percentageFee: 0.0025, // 0.25% stored as decimal (0.0025)
      flatFee: 0.00
    },
    creditCard: {
      percentageFee: 0.03, // 3% stored as decimal (0.03)
      flatFee: 0.30 // $0.30
    }
  };
}

/**
 * Calculate combined processing fees + system fees
 * @param {number} premiumAmount - Base premium amount
 * @param {string} paymentMethod - Payment method type: 'ACH' or 'Card'
 * @param {Object} paymentSettings - Tenant's PaymentProcessorSettings
 * @param {Object} systemFeesSettings - Tenant's SystemFees settings
 * @returns {number} Combined processing + system fees (rounded to 2 decimals)
 */
function calculateCombinedFees(premiumAmount, paymentMethod, paymentSettings, systemFeesSettings) {
  const systemFeesCalculator = require('./systemFeesCalculator');
  
  // Calculate payment processing fee
  const processingFee = calculateProcessingFee(premiumAmount, paymentMethod, paymentSettings);
  
  // Calculate system fees
  const systemFees = systemFeesCalculator.calculateSystemFees(premiumAmount, systemFeesSettings);
  
  // Combine and round to 2 decimals
  const combinedFees = Math.round((processingFee + systemFees) * 100) / 100;

  if (DEBUG_PRICING) {
    console.log(`💰 Combined Fees Calculation:`, {
      premium: `$${premiumAmount.toFixed(2)}`,
      processingFee: `$${processingFee.toFixed(2)}`,
      systemFees: `$${systemFees.toFixed(2)}`,
      combinedTotal: `$${combinedFees.toFixed(2)}`
    });
  }

  return combinedFees;
}

module.exports = {
  calculateProcessingFee,
  calculateHighestProcessingFee,
  calculateTotalWithProcessingFee,
  getDefaultFeeConfig,
  calculateCombinedFees,
  /** Use as paymentMethod for included-fee display: fee = max(ACH, Card). */
  PAYMENT_METHOD_HIGHEST
};

