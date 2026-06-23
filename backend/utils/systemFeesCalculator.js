const DEBUG_PRICING =
  process.env.DEBUG_PRICING === 'true' ||
  process.env.DEBUG_PRICING === '1' ||
  String(process.env.DEBUG_PRICING || '').toLowerCase() === 'yes';

/**
 * System Fees Calculator Utility
 * 
 * Calculates tenant-level system fees (Platform, Mobile App, AI Assistant)
 * These fees are configured per-tenant in oe.Tenants.SystemFees
 */

/**
 * Calculate total system fees for a member enrollment
 * @param {number} premiumAmount - Total monthly premium amount
 * @param {Object} systemFeesSettings - Parsed SystemFees from oe.Tenants.SystemFees
 * @returns {number} Total system fees (member-paid only, rounded to 2 decimals)
 */
function calculateSystemFees(premiumAmount, systemFeesSettings) {
  // If no system fees configured, return 0
  if (!systemFeesSettings) {
    return 0;
  }

  let totalSystemFees = 0;

  // Process each fee type
  const feeTypes = ['platformFee', 'mobileAppFee', 'aiAssistantFee'];

  feeTypes.forEach(feeType => {
    const fee = systemFeesSettings[feeType];

    // Skip if fee is not configured, not enabled, or not member-paid
    if (!fee || !fee.enabled || !fee.MemberPaid) {
      return;
    }

    let feeAmount = 0;

    if (fee.FlatOrPercent === 'Percent') {
      // Percentage-based fee - calculate from premium
      const percentageValue = fee.MemberPaidAmount || fee.amount || 0;
      feeAmount = (premiumAmount * percentageValue) / 100;
    } else {
      // Flat fee - use MemberPaidAmount if set, otherwise use amount
      feeAmount = fee.MemberPaidAmount !== undefined && fee.MemberPaidAmount !== null 
        ? fee.MemberPaidAmount 
        : fee.amount || 0;
    }

    totalSystemFees += feeAmount;

    if (DEBUG_PRICING) {
      console.log(`💰 System Fee [${feeType}]:`, {
        name: fee.name,
        type: fee.FlatOrPercent,
        baseAmount: fee.amount,
        memberPaidAmount: fee.MemberPaidAmount,
        calculatedFee: `$${feeAmount.toFixed(2)}`
      });
    }
  });

  // Round to 2 decimals
  const roundedTotal = Math.round(totalSystemFees * 100) / 100;

  if (DEBUG_PRICING) {
    console.log(`💰 Total System Fees (member-paid only): $${roundedTotal.toFixed(2)}`);
  }

  return roundedTotal;
}

/**
 * Get system fees breakdown for display/reporting
 * @param {number} premiumAmount - Total monthly premium amount
 * @param {Object} systemFeesSettings - Parsed SystemFees from oe.Tenants.SystemFees
 * @returns {Object} Breakdown of each fee type
 */
function getSystemFeesBreakdown(premiumAmount, systemFeesSettings) {
  if (!systemFeesSettings) {
    return {
      platformFee: 0,
      mobileAppFee: 0,
      aiAssistantFee: 0,
      total: 0
    };
  }

  const breakdown = {
    platformFee: 0,
    mobileAppFee: 0,
    aiAssistantFee: 0,
    total: 0
  };

  const feeTypes = ['platformFee', 'mobileAppFee', 'aiAssistantFee'];

  feeTypes.forEach(feeType => {
    const fee = systemFeesSettings[feeType];

    if (!fee || !fee.enabled || !fee.MemberPaid) {
      return;
    }

    let feeAmount = 0;

    if (fee.FlatOrPercent === 'Percent') {
      const percentageValue = fee.MemberPaidAmount || fee.amount || 0;
      feeAmount = (premiumAmount * percentageValue) / 100;
    } else {
      feeAmount = fee.MemberPaidAmount !== undefined && fee.MemberPaidAmount !== null 
        ? fee.MemberPaidAmount 
        : fee.amount || 0;
    }

    breakdown[feeType] = Math.round(feeAmount * 100) / 100;
  });

  breakdown.total = Object.values(breakdown).reduce((sum, val) => sum + val, 0);
  breakdown.total = Math.round(breakdown.total * 100) / 100;

  return breakdown;
}

module.exports = {
  calculateSystemFees,
  getSystemFeesBreakdown
};

