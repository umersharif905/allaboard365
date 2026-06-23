import { useQuery } from '@tanstack/react-query';
import { apiService } from '../services/api.service';

export const useProducts = (
  filters?: { search?: string; productType?: string; status?: string },
  options?: { enabled?: boolean }
) => {
  return useQuery({
    queryKey: ['products', filters],
    queryFn: async () => {
      const queryParams = new URLSearchParams();
      if (filters?.search) queryParams.append('search', filters.search);
      if (filters?.productType) queryParams.append('productType', filters.productType);
      if (filters?.status) queryParams.append('status', filters.status);
      
      // Always get active products only
      queryParams.append('status', 'Active');
      
      // Use the marketplace products endpoint
      const response = await apiService.get(`/api/marketplace/products?${queryParams.toString()}`);
      return (response as any).products || []; // Type assertion to fix TypeScript error
    },
    enabled: options?.enabled !== false
  });
};