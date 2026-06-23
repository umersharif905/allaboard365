import { useQuery } from '@tanstack/react-query';
import { apiService } from '../../services/api.service';

export interface TenantCommissionGroupOption {
  CommissionGroupId: string;
  Name: string;
}

export const useTenantCommissionProductGroups = (productId: string | null, enabled: boolean) => {
  return useQuery<TenantCommissionGroupOption[], Error>({
    queryKey: ['tenantCommissionProductGroups', productId],
    queryFn: async () => {
      if (!productId) throw new Error('Product ID is required');
      const res = await apiService.get<{
        success: boolean;
        data?: TenantCommissionGroupOption[];
        message?: string;
      }>(`/api/me/agent/products/${productId}/commission-groups`);
      if (!res.success || !res.data) {
        throw new Error(res.message || 'Failed to load commission groups');
      }
      return res.data;
    },
    enabled: !!productId && enabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 1
  });
};
