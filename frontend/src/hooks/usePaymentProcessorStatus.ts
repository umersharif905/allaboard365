// frontend/src/hooks/usePaymentProcessorStatus.ts
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api.service';

interface PaymentProcessorStatus {
  hasApiToken: boolean;
  processorName?: string;
}

/**
 * Hook to check if the tenant has payment processor API token configured
 */
export const usePaymentProcessorStatus = () => {
  const { user, isLoading: isAuthLoading } = useAuth();

  return useQuery<PaymentProcessorStatus>({
    queryKey: ['paymentProcessorStatus', user?.currentTenantId],
    queryFn: async () => {
      if (!user?.currentTenantId) {
        return { hasApiToken: false };
      }

      try {
        // Check based on user role
        let endpoint = '';
        if (user.currentRole === 'Agent') {
          endpoint = '/api/me/agent/payment-processor-status';
        } else if (user.currentRole === 'TenantAdmin') {
          endpoint = '/api/me/tenant-admin/payment-processor-status';
        } else if (user.currentRole === 'SysAdmin') {
          // For SysAdmin, we might need tenantId in query
          endpoint = `/api/me/sysadmin/payment-processor-status?tenantId=${user.currentTenantId}`;
        } else {
          return { hasApiToken: false };
        }

        const response = await apiService.get<{ success: boolean; data?: PaymentProcessorStatus }>(endpoint);
        
        if (response.success && response.data) {
          return response.data;
        }
        
        return { hasApiToken: false };
      } catch (error) {
        console.error('Error checking payment processor status:', error);
        // Default to false on error to show warning
        return { hasApiToken: false };
      }
    },
    enabled: !isAuthLoading && !!user?.currentTenantId,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });
};

