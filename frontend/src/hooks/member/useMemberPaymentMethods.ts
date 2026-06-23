import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreatePaymentMethodData, MemberPaymentMethodsService, UpdatePaymentMethodData } from '../../services/member-payment-methods.service';

export const useMemberPaymentMethods = () => {
  return useQuery({
    queryKey: ['member-payment-methods'],
    queryFn: () => MemberPaymentMethodsService.getPaymentMethods(),
    select: (response) => response.data || []
  });
};

export const useAddPaymentMethod = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreatePaymentMethodData) => MemberPaymentMethodsService.addPaymentMethod(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-payment-methods'] });
    }
  });
};

export const useUpdatePaymentMethod = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: UpdatePaymentMethodData) => MemberPaymentMethodsService.updatePaymentMethod(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-payment-methods'] });
    }
  });
};

export const useDeletePaymentMethod = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (paymentMethodId: string) => MemberPaymentMethodsService.deletePaymentMethod(paymentMethodId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-payment-methods'] });
    }
  });
};

export const useSetDefaultPaymentMethod = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (paymentMethodId: string) => MemberPaymentMethodsService.setDefaultPaymentMethod(paymentMethodId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-payment-methods'] });
    }
  });
};
