import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IndividualPaymentsService, ProcessInitialPaymentRequest } from '../services/individual-payments.service';

/**
 * Hook to get payment status for a household
 */
export const useHouseholdPaymentStatus = (householdId: string | null) => {
  return useQuery({
    queryKey: ['household-payment-status', householdId],
    queryFn: () => IndividualPaymentsService.getHouseholdPaymentStatus(householdId!),
    enabled: !!householdId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 2
  });
};

/**
 * Hook to get total premium amount for a household
 */
export const useHouseholdPremium = (householdId: string | null) => {
  return useQuery({
    queryKey: ['household-premium', householdId],
    queryFn: () => IndividualPaymentsService.getHouseholdPremium(householdId!),
    enabled: !!householdId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 2
  });
};

/**
 * Hook to process initial payment for individual enrollment
 */
export const useProcessInitialPayment = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: ProcessInitialPaymentRequest) => 
      IndividualPaymentsService.processInitialPayment(request),
    onSuccess: (data, variables) => {
      // Invalidate payment status queries for the household
      if (data.success && data.data?.householdId) {
        queryClient.invalidateQueries({
          queryKey: ['household-payment-status', data.data.householdId]
        });
        queryClient.invalidateQueries({
          queryKey: ['household-premium', data.data.householdId]
        });
      }
    },
    onError: (error) => {
      console.error('❌ Payment processing error:', error);
    }
  });
};
