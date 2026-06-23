import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api.service';

interface Payment {
    PaymentId: string;
    InvoiceId?: string;
    Amount: number;
    PaymentDate: string;
    Status: string;
    PaymentMethod: string;
    EnrollmentId: string;
    NextBillingDate?: string;
    ProcessorTransactionId?: string;
    FailureReason?: string;
}

interface PaymentsResponse {
    success: boolean;
    data: Payment[];
    message?: string;
}

export const useMemberPayments = () => {
    const { user } = useAuth();

    return useQuery({
        queryKey: ['memberPayments', user?.userId],
        queryFn: async (): Promise<Payment[]> => {
            const response = await apiService.get<PaymentsResponse>('/api/me/member/payments');
            
            if (!response.success) {
                throw new Error(response.message || 'Failed to fetch payments');
            }
            
            return response.data;
        },
        enabled: !!user,
        staleTime: 5 * 60 * 1000, // 5 minutes
        retry: 2
    });
};
