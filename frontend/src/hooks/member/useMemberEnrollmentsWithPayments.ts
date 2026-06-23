import { useMutation, useQuery } from '@tanstack/react-query';
import { apiService } from '../../services/api.service';

export interface MemberEnrollmentWithPayments {
  EnrollmentId: string;
  MemberId: string;
  ProductId: string;
  ProductName: string;
  ProductType: string;
  EnrollmentStatus: string;
  EffectiveDate: string;
  TerminationDate?: string;
  PremiumAmount: number;
  PaymentFrequency: string;
  LastPaymentDate?: string;
  PaymentStatus?: string;
  NextBillingDate?: string;
}

export const useMemberEnrollmentsWithPayments = () => {
  return useQuery({
    queryKey: ['member-enrollments-with-payments'],
    queryFn: async (): Promise<MemberEnrollmentWithPayments[]> => {
      const response = await apiService.get<{ success: boolean; data: MemberEnrollmentWithPayments[] }>('/api/me/member/payments/enrollments');
      
      if (!response.success) {
        throw new Error('Failed to fetch enrollments with payment data');
      }
      
      return response.data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};

export const useTerminatePlan = () => {
  return useMutation({
    mutationFn: async ({ enrollmentId, terminationReason }: { enrollmentId: string; terminationReason?: string }) => {
      const response = await apiService.post<{ success: boolean; data: any; message: string }>('/api/me/member/payments/terminate-plan', {
        enrollmentId,
        terminationReason
      });
      
      if (!response.success) {
        throw new Error(response.message || 'Failed to terminate plan');
      }
      
      return response;
    }
  });
};

export const useUpdatePaymentMethod = () => {
  return useMutation({
    mutationFn: async (paymentData: {
      paymentMethod: string;
      cardType?: string;
      last4Digits?: string;
      expirationDate?: string;
      bankName?: string;
    }) => {
      const response = await apiService.put<{ success: boolean; data: any; message: string }>('/api/me/member/payments/payment-method', paymentData);
      
      if (!response.success) {
        throw new Error(response.message || 'Failed to update payment method');
      }
      
      return response;
    }
  });
};
