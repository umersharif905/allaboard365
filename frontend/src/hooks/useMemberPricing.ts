/**
 * Member Pricing Hook
 * 
 * Provides current member pricing using the unified pricing system.
 * This is for regular members (not enrollment links).
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { MemberEnrollmentService } from '../services/member/member-enrollments.service';
import { PricingResult, PricingService } from '../services/pricing.service';

export const useMemberPricing = (memberId?: string) => {
  const { user, isLoading: isAuthLoading } = useAuth();

  return useQuery<PricingResult, Error>({
    queryKey: ['memberPricing', memberId, user?.currentRole],
    queryFn: async () => {
      try {
        console.log('🔍 useMemberPricing: Starting pricing calculation', {
          memberId,
          currentRole: user?.currentRole
        });

        // Get member's current enrollments to determine products
        const enrollmentsResponse = await MemberEnrollmentService.getMyEnrollments();
        
        if (!enrollmentsResponse.success) {
          throw new Error(enrollmentsResponse.message || 'Failed to get member enrollments');
        }

        const enrollments = enrollmentsResponse.data || [];
        console.log('🔍 useMemberPricing: Found enrollments', enrollments.length);

        // Get member data for criteria
        // Always get current user's member profile (no memberId parameter)
        const memberData = await MemberEnrollmentService.getMember();
        if (!memberData.success) {
          throw new Error(memberData.message || 'Failed to get member data');
        }

        const member = memberData.data;
        console.log('🔍 useMemberPricing: Member data', {
          age: member.age,
          tobaccoUse: member.tobaccoUse,
          tier: member.tier,
          householdSize: member.householdSize
        });

        // Build member criteria
        const memberCriteria = {
          age: member.age || 35,
          tobaccoUse: member.tobaccoUse || 'No',
          tier: member.tier || 'EE',
          householdSize: member.householdSize || 1
        };

        console.log('🔍 useMemberPricing: Member criteria', memberCriteria);

        // Build selected products and configurations from current enrollments
        const selectedProducts = enrollments.map(enrollment => enrollment.productId);
        const selectedConfigs = enrollments.reduce((configs, enrollment) => {
          if (enrollment.configValues && Object.keys(enrollment.configValues).length > 0) {
            configs[enrollment.productId] = enrollment.configValues;
          }
          return configs;
        }, {} as Record<string, Record<string, any>>);

        console.log('🔍 useMemberPricing: Selected products', selectedProducts);
        console.log('🔍 useMemberPricing: Selected configs', selectedConfigs);

        // Use the unified pricing service
        const pricingResult = await PricingService.calculatePricing({
          memberId: member.id, // Use the member ID from the profile data
          calculationType: 'current',
          memberCriteria,
          productSelections: selectedProducts.map(productId => ({ 
            productId,
            configValues: selectedConfigs[productId] || {}
          }))
        });

        console.log('🔍 useMemberPricing: Pricing result', pricingResult);

        return pricingResult;
      } catch (error) {
        console.error('❌ useMemberPricing: Error calculating pricing', error);
        throw error;
      }
    },
    enabled: !isAuthLoading && !!user,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};