/**
 * Monthly contribution totals from oe.Enrollments — matches billing (sum PremiumAmount only).
 * IncludedPaymentProcessingFeeAmount / IncludedSystemFeeAmount are display allocations on
 * product rows; they must not be added on top of PaymentProcessingFee / SystemFee enrollment rows.
 */

export const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';

export type EnrollmentLike = {
  enrollmentType?: string | null;
  EnrollmentType?: string | null;
  premiumAmount?: number | null;
  PremiumAmount?: number | null;
  employerContributionAmount?: number | null;
  EmployerContributionAmount?: number | null;
  productId?: string | null;
  ProductId?: string | null;
  status?: string | null;
  terminationDate?: string | null;
};

/** Active or pending future enrollments — same rules as useMemberContributions. */
export function isEnrollmentActiveForContributions(e: EnrollmentLike): boolean {
  if (e.status === 'Pending') return true;
  if (e.status !== 'Active') return false;
  if (e.terminationDate) {
    return new Date(e.terminationDate) > new Date();
  }
  return true;
}

export interface MemberContributionTotals {
  /** Sum of PremiumAmount on Product enrollments (raw, no included* columns). */
  totalProductPremium: number;
  /** Sum of PremiumAmount on SystemFee + PaymentProcessingFee / ProcessingFee rows. */
  processingFee: number;
  totalEmployerContribution: number;
  /** Product premium minus employer (fees excluded). */
  totalMonthlyContribution: number;
  /** What the member pays monthly — product + fee enrollment PremiumAmounts minus employer. */
  yourContribution: number;
}

export function getEnrollmentType(e: EnrollmentLike): string {
  const t = e.enrollmentType ?? e.EnrollmentType;
  return t == null || t === '' ? 'Product' : String(t);
}

export function getPremiumAmount(e: EnrollmentLike): number {
  const n = Number(e.premiumAmount ?? e.PremiumAmount ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function computeMemberContributionTotals(
  enrollments: EnrollmentLike[],
  isActive: (e: EnrollmentLike) => boolean
): MemberContributionTotals {
  let totalProductPremium = 0;
  let processingFee = 0;
  let totalEmployerContribution = 0;

  for (const e of enrollments) {
    if (!isActive(e)) continue;
    const type = getEnrollmentType(e);
    const amount = getPremiumAmount(e);

    if (type === 'Contribution') {
      totalEmployerContribution +=
        Number(e.employerContributionAmount ?? e.EmployerContributionAmount ?? 0) || 0;
    } else if (
      type === 'PaymentProcessingFee' ||
      type === 'ProcessingFee' ||
      type === 'SystemFee'
    ) {
      processingFee += amount;
    } else if (type === 'Product') {
      const pid = String(e.productId ?? e.ProductId ?? '').toLowerCase();
      if (pid !== ALL_PRODUCTS_GUID) {
        totalProductPremium += amount;
      }
    }
  }

  const totalMonthlyContribution = Math.max(0, totalProductPremium - totalEmployerContribution);
  const yourContribution = Math.max(
    0,
    totalProductPremium + processingFee - totalEmployerContribution
  );

  return {
    totalProductPremium,
    processingFee,
    totalEmployerContribution,
    totalMonthlyContribution,
    yourContribution,
  };
}
