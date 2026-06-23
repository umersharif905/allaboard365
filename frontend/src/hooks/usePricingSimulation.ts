/**
 * Pricing Simulation Hook
 *
 * Provides pricing simulation for plan modification scenarios like:
 * - Adding/removing dependents
 * - Changing products
 * - Modifying configurations
 *
 * Uses the new unified pricing system with proper configuration support.
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { MemberEnrollmentService } from '../services/member/member-enrollments.service';
import { PricingResult, PricingService, SimulationContext } from '../services/pricing.service';

interface MemberCriteria {
  age: number;
  tobaccoUse: string;
  tier: string;
  householdSize: number;
}

export interface SimulationChanges {
  addProducts?: string[];
  removeProducts?: string[];
  configChanges?: Record<string, Record<string, any>>;
  /**
   * Dependent add/remove tier preview. Merged with add/remove product lists for POST /api/pricing/calculate
   * (simulationContext is required by the API when calculationType is simulation).
   */
  simulationContext?: SimulationContext;
}

function buildSimulationContextPayload(simulationChanges: SimulationChanges): SimulationContext {
  const nested = simulationChanges.simulationContext;
  const changes: NonNullable<SimulationContext['changes']> = {
    ...(nested?.changes || {}),
  };
  if (simulationChanges.addProducts?.length) {
    changes.addProducts = [...simulationChanges.addProducts];
  }
  if (simulationChanges.removeProducts?.length) {
    changes.removeProducts = [...simulationChanges.removeProducts];
  }
  return {
    type: nested?.type ?? 'change-products',
    changes,
  };
}

export const usePricingSimulation = (
  memberId?: string,
  simulationChanges: SimulationChanges = {},
  enabled: boolean = true
) => {
  const { user, isLoading: isAuthLoading } = useAuth();

  return useQuery<PricingResult, Error>({
    queryKey: ['pricingSimulation', memberId, simulationChanges, user?.currentRole],
    queryFn: async () => {
      try {
        console.log('🔍 usePricingSimulation: Starting simulation', {
          memberId,
          simulationChanges,
          currentRole: user?.currentRole,
        });

        // Get member's current enrollments
        const enrollmentsResponse = await MemberEnrollmentService.getMyEnrollments();

        if (!enrollmentsResponse.success) {
          throw new Error(enrollmentsResponse.message || 'Failed to get member enrollments');
        }

        const currentEnrollments = enrollmentsResponse.data || [];
        console.log('🔍 usePricingSimulation: Current enrollments', currentEnrollments.length);

        // Get member data for criteria
        const memberData = await MemberEnrollmentService.getMember(memberId);
        if (!memberData.success || !memberData.data) {
          throw new Error(memberData.message || 'Failed to get member data');
        }

        const member = memberData.data;
        const effectiveMemberId: string | undefined =
          member.id || member.memberId || memberId || (user as { memberId?: string })?.memberId;
        if (!effectiveMemberId) {
          throw new Error('Member ID not available for pricing simulation');
        }

        // Build member criteria from member data (engine may override for simulation)
        const memberCriteria: MemberCriteria = {
          age: calculateAge(member.dateOfBirth || '1990-01-01'),
          tobaccoUse: member.tobaccoUse || 'No',
          tier: member.tier || 'EE',
          householdSize: member.householdSize || 1,
        };

        console.log('🔍 usePricingSimulation: Member criteria', memberCriteria);

        const simulationContext = buildSimulationContextPayload(simulationChanges);

        // Build new product selections based on simulation changes (for request shape; engine applies simulationContext)
        const currentProducts = currentEnrollments.map((enrollment) => enrollment.productId);
        const newProducts = [
          ...currentProducts.filter((id) => !simulationChanges.removeProducts?.includes(id)),
          ...(simulationChanges.addProducts || []),
        ];

        console.log('🔍 usePricingSimulation: Product changes', {
          currentProducts,
          addProducts: simulationChanges.addProducts,
          removeProducts: simulationChanges.removeProducts,
          newProducts,
        });

        // Build new configurations based on simulation changes
        const currentConfigs = currentEnrollments.reduce(
          (configs, enrollment) => {
            if (enrollment.configValues && Object.keys(enrollment.configValues).length > 0) {
              configs[enrollment.productId] = enrollment.configValues;
            }
            return configs;
          },
          {} as Record<string, Record<string, any>>
        );

        const newConfigs = {
          ...currentConfigs,
          ...simulationChanges.configChanges,
        };

        console.log('🔍 usePricingSimulation: Config changes', {
          currentConfigs,
          configChanges: simulationChanges.configChanges,
          newConfigs,
        });

        const pricingResult = await PricingService.calculatePricing({
          memberId: effectiveMemberId,
          calculationType: 'simulation',
          memberCriteria,
          productSelections: newProducts.map((productId) => ({
            productId,
            configValues: newConfigs[productId] || {},
          })),
          simulationContext,
        });

        console.log('🔍 usePricingSimulation: Simulation calculated successfully', {
          productsCount: pricingResult?.products?.length || 0,
          totalPremium: pricingResult?.totals?.totalPremium || 0,
        });

        return pricingResult;
      } catch (error) {
        console.error('❌ usePricingSimulation: Error calculating simulation', error);
        throw error;
      }
    },
    enabled: enabled && !isAuthLoading && !!user?.currentRole,
    staleTime: 1 * 60 * 1000, // 1 minute for simulations
    retry: 1,
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

export default usePricingSimulation;
