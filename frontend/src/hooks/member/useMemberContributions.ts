import { useMemo } from 'react';
import { GroupedEnrollment, MemberEnrollment, MemberEnrollmentService } from '../../services/member/member-enrollments.service';
import {
  ALL_PRODUCTS_GUID,
  computeMemberContributionTotals,
  isEnrollmentActiveForContributions,
} from '../../utils/memberContributionTotals';
import { useMemberEnrollments } from './useMemberEnrollments';

export interface MemberContributions {
  // Raw data
  enrollments: MemberEnrollment[];
  groupedEnrollments: GroupedEnrollment[];
  activeGroupedEnrollments: GroupedEnrollment[];
  contributionEnrollments: MemberEnrollment[];
  processingFeeEnrollments: MemberEnrollment[];

  // Calculated values
  totalProductPremium: number;
  totalEmployerContribution: number;
  processingFee: number;
  totalMonthlyContribution: number; // Employee contribution (premium - employer)
  yourContribution: number; // Product + fee PremiumAmounts minus employer

  // Flags
  hasEmployerContribution: boolean;

  // Loading states
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

/**
 * Hook to calculate all member contribution values consistently across the codebase
 * 
 * This hook centralizes all contribution calculations to ensure consistency:
 * - Total product premium (Product PremiumAmount only — no included* columns)
 * - Employer contribution (from Contribution enrollments only)
 * - Processing fees (PaymentProcessingFee / SystemFee PremiumAmount only)
 * - Your contribution (product + fees PremiumAmounts minus employer; matches billing)
 * 
 * @returns MemberContributions object with all calculated values
 */
export const useMemberContributions = (): MemberContributions => {
  const { 
    data: enrollments, 
    isLoading: enrollmentsLoading, 
    isError: enrollmentsError,
    error: enrollmentsErrorObj
  } = useMemberEnrollments();
  
  const contributionEnrollments = useMemo(() => {
    if (!enrollments || enrollments.length === 0) return [];
    return enrollments.filter((e: MemberEnrollment) => {
      const enrollmentType = e.enrollmentType || (e as any)?.EnrollmentType;
      return enrollmentType === 'Contribution' && isEnrollmentActiveForContributions(e);
    });
  }, [enrollments]);
  
  const processingFeeEnrollments = useMemo(() => {
    if (!enrollments || enrollments.length === 0) return [];
    return enrollments.filter((e: MemberEnrollment) => {
      const enrollmentType = e.enrollmentType || (e as any)?.EnrollmentType;
      return (enrollmentType === 'PaymentProcessingFee' || 
              enrollmentType === 'ProcessingFee' || 
              enrollmentType === 'SystemFee') && 
             isEnrollmentActiveForContributions(e);
    });
  }, [enrollments]);
  
  // Derive grouped enrollments from raw enrollments (filter out fees and contributions)
  const groupedEnrollmentsRaw = useMemo(() => {
    if (!enrollments || enrollments.length === 0) return [];
    const productEnrollments = enrollments.filter((e: MemberEnrollment) => {
      const enrollmentType = e.enrollmentType || (e as any)?.EnrollmentType;
      // Exclude Contribution, PaymentProcessingFee, ProcessingFee, and SystemFee enrollments
      return enrollmentType !== 'Contribution' && 
             enrollmentType !== 'PaymentProcessingFee' && 
             enrollmentType !== 'ProcessingFee' && 
             enrollmentType !== 'SystemFee';
    });
    return MemberEnrollmentService.groupEnrollmentsByBundle(productEnrollments);
  }, [enrollments]);
  
  const groupedEnrollments = useMemo(() => {
    return groupedEnrollmentsRaw?.filter((e: GroupedEnrollment) => 
      e.primaryEnrollment?.productId !== ALL_PRODUCTS_GUID
    ) || [];
  }, [groupedEnrollmentsRaw]);
  
  const activeGroupedEnrollments = useMemo(() => {
    return groupedEnrollments?.filter((e: GroupedEnrollment) => {
      // Check if the primary enrollment is truly active (not terminated)
      if (e.primaryEnrollment) {
        return isEnrollmentActiveForContributions(e.primaryEnrollment);
      }
      // Fallback to status check if no primary enrollment
      return e.status === 'Active';
    }) || [];
  }, [groupedEnrollments]);

  const contributionTotals = useMemo(
    () => computeMemberContributionTotals(enrollments || [], isEnrollmentActiveForContributions),
    [enrollments]
  );

  const {
    totalProductPremium,
    totalEmployerContribution,
    processingFee,
    totalMonthlyContribution,
    yourContribution,
  } = contributionTotals;

  const hasEmployerContribution = totalEmployerContribution > 0;
  
  return {
    // Raw data
    enrollments: enrollments || [],
    groupedEnrollments,
    activeGroupedEnrollments,
    contributionEnrollments,
    processingFeeEnrollments,

    // Calculated values
    totalProductPremium,
    totalEmployerContribution,
    processingFee,
    totalMonthlyContribution,
    yourContribution,

    // Flags
    hasEmployerContribution,

    // Loading states
    isLoading: enrollmentsLoading,
    isError: enrollmentsError,
    error: enrollmentsErrorObj || null,
  };
};
