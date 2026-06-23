/**
 * System Fees Calculator Service
 * 
 * Frontend service for calculating tenant-level system fees
 * Matches backend logic for consistent fee calculations
 */

export interface SystemFeesSettings {
  platformFee?: SystemFee;
  mobileAppFee?: SystemFee;
  aiAssistantFee?: SystemFee;
}

export interface SystemFee {
  name: string;
  amount: number;
  type: 'fixed' | 'percentage';
  description: string;
  enabled: boolean;
  MemberPaid?: boolean;
  FlatOrPercent?: 'Flat' | 'Percent';
  MemberPaidAmount?: number;
}

export interface SystemFeesBreakdown {
  platformFee: number;
  mobileAppFee: number;
  aiAssistantFee: number;
  total: number;
}

/**
 * Calculate total system fees for a member enrollment
 * @param premiumAmount - Total monthly premium amount
 * @param systemFeesSettings - Tenant's SystemFees settings
 * @returns Total system fees (member-paid only, rounded to 2 decimals)
 */
export function calculateSystemFees(
  premiumAmount: number,
  systemFeesSettings: SystemFeesSettings | null
): number {
  // If no system fees configured, return 0
  if (!systemFeesSettings) {
    return 0;
  }

  let totalSystemFees = 0;

  // Process each fee type
  const feeTypes: Array<keyof SystemFeesSettings> = ['platformFee', 'mobileAppFee', 'aiAssistantFee'];

  feeTypes.forEach(feeType => {
    const fee = systemFeesSettings[feeType];

    // Skip if fee is not configured, not enabled, or not member-paid
    if (!fee || !fee.enabled || !fee.MemberPaid) {
      return;
    }

    let feeAmount = 0;

    if (fee.FlatOrPercent === 'Percent') {
      // Percentage-based fee - calculate from premium
      const percentageValue = fee.MemberPaidAmount ?? fee.amount ?? 0;
      feeAmount = (premiumAmount * percentageValue) / 100;
    } else {
      // Flat fee - use MemberPaidAmount if set, otherwise use amount
      feeAmount = fee.MemberPaidAmount !== undefined && fee.MemberPaidAmount !== null 
        ? fee.MemberPaidAmount 
        : fee.amount ?? 0;
    }

    totalSystemFees += feeAmount;

    console.log(`💰 System Fee [${feeType}]:`, {
      name: fee.name,
      type: fee.FlatOrPercent,
      baseAmount: fee.amount,
      memberPaidAmount: fee.MemberPaidAmount,
      calculatedFee: `$${feeAmount.toFixed(2)}`
    });
  });

  // Round to 2 decimals
  const roundedTotal = Math.round(totalSystemFees * 100) / 100;

  console.log(`💰 Total System Fees (member-paid only): $${roundedTotal.toFixed(2)}`);

  return roundedTotal;
}

/**
 * Get system fees breakdown for display/reporting
 * @param premiumAmount - Total monthly premium amount
 * @param systemFeesSettings - Tenant's SystemFees settings
 * @returns Breakdown of each fee type
 */
export function getSystemFeesBreakdown(
  premiumAmount: number,
  systemFeesSettings: SystemFeesSettings | null
): SystemFeesBreakdown {
  if (!systemFeesSettings) {
    return {
      platformFee: 0,
      mobileAppFee: 0,
      aiAssistantFee: 0,
      total: 0
    };
  }

  const breakdown: SystemFeesBreakdown = {
    platformFee: 0,
    mobileAppFee: 0,
    aiAssistantFee: 0,
    total: 0
  };

  const feeTypes: Array<keyof SystemFeesSettings> = ['platformFee', 'mobileAppFee', 'aiAssistantFee'];

  feeTypes.forEach(feeType => {
    const fee = systemFeesSettings[feeType];

    if (!fee || !fee.enabled || !fee.MemberPaid) {
      return;
    }

    let feeAmount = 0;

    if (fee.FlatOrPercent === 'Percent') {
      const percentageValue = fee.MemberPaidAmount ?? fee.amount ?? 0;
      feeAmount = (premiumAmount * percentageValue) / 100;
    } else {
      feeAmount = fee.MemberPaidAmount !== undefined && fee.MemberPaidAmount !== null 
        ? fee.MemberPaidAmount 
        : fee.amount ?? 0;
    }

    breakdown[feeType] = Math.round(feeAmount * 100) / 100;
  });

  breakdown.total = Math.round(
    (breakdown.platformFee + breakdown.mobileAppFee + breakdown.aiAssistantFee) * 100
  ) / 100;

  return breakdown;
}

