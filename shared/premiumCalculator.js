/**
 * Premium Calculator for Group Payments
 * 
 * Calculates total monthly premium including system fees for group billing
 */

/**
 * Calculate total monthly amount for a group including system fees
 * @param {number} basePremium - Total of all enrollment premiums
 * @param {number} householdCount - Number of unique households in the group
 * @param {Object} systemFeesSettings - Parsed SystemFees from oe.Tenants.SystemFees
 * @returns {number} Total monthly amount (premium + system fees per household)
 */
function calculateGroupMonthlyTotal(basePremium, householdCount, systemFeesSettings) {
  if (!systemFeesSettings || householdCount === 0) {
    return basePremium;
  }

  // Calculate average premium per household (for percentage-based fees)
  const averagePremiumPerHousehold = basePremium / householdCount;

  let totalSystemFees = 0;
  const feeTypes = ['platformFee', 'mobileAppFee', 'aiAssistantFee'];

  feeTypes.forEach(feeType => {
    const fee = systemFeesSettings[feeType];

    // Skip if not enabled or not member-paid
    if (!fee || !fee.enabled || !fee.MemberPaid) {
      return;
    }

    let feeAmountPerHousehold = 0;

    if (fee.FlatOrPercent === 'Percent') {
      // Percentage-based - calculate from average household premium
      const percentageValue = fee.MemberPaidAmount || fee.amount || 0;
      feeAmountPerHousehold = (averagePremiumPerHousehold * percentageValue) / 100;
    } else {
      // Flat fee per household
      feeAmountPerHousehold = fee.MemberPaidAmount !== undefined && fee.MemberPaidAmount !== null 
        ? fee.MemberPaidAmount 
        : fee.amount || 0;
    }

    // Multiply by household count to get total for all households
    const totalFeeForAllHouseholds = feeAmountPerHousehold * householdCount;
    totalSystemFees += totalFeeForAllHouseholds;

    console.log(`💰 Group System Fee [${feeType}]:`, {
      name: fee.name,
      type: fee.FlatOrPercent,
      perHousehold: `$${feeAmountPerHousehold.toFixed(2)}`,
      households: householdCount,
      totalForGroup: `$${totalFeeForAllHouseholds.toFixed(2)}`
    });
  });

  const totalAmount = Math.round((basePremium + totalSystemFees) * 100) / 100;

  console.log(`💰 Group Total Calculation:`, {
    basePremium: `$${basePremium.toFixed(2)}`,
    systemFees: `$${totalSystemFees.toFixed(2)}`,
    households: householdCount,
    total: `$${totalAmount.toFixed(2)}`
  });

  return totalAmount;
}

module.exports = {
  calculateGroupMonthlyTotal
};

