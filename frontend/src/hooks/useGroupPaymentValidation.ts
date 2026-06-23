// frontend/src/hooks/useGroupPaymentValidation.ts
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { GroupsService } from '../services/groups.service';

/**
 * Hook to check if a group has valid payment methods
 * @param groupId The ID of the group to check
 */
export const useGroupPaymentValidation = (groupId: string | undefined) => {
  const { user, isLoading: isAuthLoading } = useAuth();
  
  return useQuery({
    queryKey: ['groupPaymentValidation', groupId],
    queryFn: async () => {
      if (!groupId) {
        return { hasValidPaymentMethod: false, paymentMethod: null };
      }
      
      try {
        const response = await GroupsService.getGroupBillingData(groupId);
        
        if (response.success && response.data) {
          const { paymentMethod } = response.data;
          
          // Check if there's a valid payment method that is active
          const hasValidPaymentMethod = !!paymentMethod && paymentMethod.Status === 'Active';
          
          return {
            hasValidPaymentMethod,
            paymentMethod: paymentMethod,
            billingData: response.data
          };
        }
        
        return { hasValidPaymentMethod: false, paymentMethod: null };
      } catch (error) {
        console.error('Error checking group payment methods:', error);
        return { hasValidPaymentMethod: false, paymentMethod: null };
      }
    },
    enabled: !isAuthLoading && !!user && !!groupId,
    staleTime: 30 * 1000, // 30 seconds
    retry: 1
  });
};
