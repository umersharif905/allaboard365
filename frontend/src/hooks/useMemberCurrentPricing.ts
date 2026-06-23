/**
 * Member Current Pricing Hook
 * 
 * Provides current member pricing using the new unified pricing system.
 * Replaces the old useCurrentPricing hook with proper configuration support.
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { EnrollmentLinkService } from '../services/enrollment-link.service';
import { MemberEnrollmentService } from '../services/member/member-enrollments.service';

interface MemberCriteria {
  age: number;
  tobaccoUse: string;
  tier: string;
  householdSize: number;
}

export const useMemberCurrentPricing = (memberId?: string) => {
  const { user, isLoading: isAuthLoading } = useAuth();

  return useQuery({
    queryKey: ['memberCurrentPricing', memberId, user?.currentRole],
    queryFn: async () => {
      try {
        console.log('🔍 useMemberCurrentPricing: Starting pricing calculation', {
          memberId,
          currentRole: user?.currentRole
        });

        // Get member's current enrollments to determine products
        const enrollmentsResponse = await MemberEnrollmentService.getMyEnrollments();
        
        if (!enrollmentsResponse.success) {
          throw new Error(enrollmentsResponse.message || 'Failed to get member enrollments');
        }

        const enrollments = enrollmentsResponse.data || [];
        console.log('🔍 useMemberCurrentPricing: Found enrollments', enrollments.length);

        // Get member data for criteria
        const memberData = await MemberEnrollmentService.getMember(memberId);
        if (!memberData.success) {
          throw new Error(memberData.message || 'Failed to get member data');
        }

        const member = memberData.data;
        console.log('🔍 useMemberCurrentPricing: Member data', {
          dateOfBirth: member.dateOfBirth,
          tobaccoUse: member.tobaccoUse,
          tier: member.tier
        });

        // Build member criteria from member data
        const memberCriteria: MemberCriteria = {
          age: calculateAge(member.dateOfBirth || '1990-01-01'),
          tobaccoUse: member.tobaccoUse || 'No',
          tier: member.tier || 'EE',
          householdSize: member.householdSize || 1
        };

        console.log('🔍 useMemberCurrentPricing: Member criteria', memberCriteria);

        // Get enrollment link token for the member's group
        const enrollmentLinkToken = await MemberEnrollmentService.getMemberEnrollmentLinkToken(memberId);
        if (!enrollmentLinkToken) {
          throw new Error('No enrollment link token found for member');
        }

        console.log('🔍 useMemberCurrentPricing: Enrollment link token', enrollmentLinkToken);

        // Build selected products and configurations from current enrollments
        const selectedProducts = enrollments.map(enrollment => enrollment.productId);
        const selectedConfigs = enrollments.reduce((configs, enrollment) => {
          if (enrollment.configValues && Object.keys(enrollment.configValues).length > 0) {
            configs[enrollment.productId] = enrollment.configValues;
          }
          return configs;
        }, {} as Record<string, Record<string, any>>);

        console.log('🔍 useMemberCurrentPricing: Selected products', selectedProducts);
        console.log('🔍 useMemberCurrentPricing: Selected configs', selectedConfigs);

        // Get pricing for all enrolled products using the unified system
        const pricingResponse = await EnrollmentLinkService.calculatePricing(
          enrollmentLinkToken,
          memberCriteria,
          selectedProducts,
          selectedConfigs
        );

        if (!pricingResponse.success) {
          throw new Error(pricingResponse.message || 'Failed to calculate pricing');
        }

        console.log('🔍 useMemberCurrentPricing: Pricing calculated successfully', {
          productsCount: pricingResponse.data?.products?.length || 0
        });

        return pricingResponse.data;
      } catch (error) {
        console.error('❌ useMemberCurrentPricing: Error calculating pricing', error);
        throw error;
      }
    },
    enabled: !isAuthLoading && !!user?.currentRole,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 2
  });
};

/**
 * Calculate age from date of birth
 */
function calculateAge(dateOfBirth: string): number {
  const today = new Date();
  const birthDate = new Date(dateOfBirth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  
  return age;
}

export default useMemberCurrentPricing;
