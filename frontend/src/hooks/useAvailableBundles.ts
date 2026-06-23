// frontend/src/hooks/useAvailableBundles.ts
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api.service';

export interface Bundle {
  ProductId: string;
  Name: string;
  ProductType: string;
  Description?: string;
  IsBundle: boolean | number; // Handle both database (1) and API (true) formats
  Status: string; // Use Status instead of IsActive
}

/**
 * Hook to fetch available product bundles based on user role
 */
export const useAvailableBundles = (tenantId?: string) => {
  const { user, isLoading: isAuthLoading } = useAuth();

  return useQuery({
    queryKey: ['available-bundles', user?.currentRole, tenantId],
    queryFn: async (): Promise<Bundle[]> => {
      if (!user?.currentRole) {
        throw new Error('User role not available');
      }

      let endpoint: string;
      
      switch (user.currentRole) {
        case 'SysAdmin':
          // For SysAdmin, we need a tenant to get tenant-specific products
          if (!tenantId) {
            return []; // Return empty array if no tenant selected
          }
          endpoint = `/api/tenants/${tenantId}/products`;
          break;
        case 'TenantAdmin':
          // Use role-specific endpoint for TenantAdmin (follows @backend-system.md)
          endpoint = '/api/me/tenant-admin/products';
          break;
        case 'Agent':
          // Use role-specific endpoint for Agent (follows @backend-system.md)
          endpoint = '/api/me/agent/products';
          break;
        default:
          throw new Error(`Unsupported role: ${user.currentRole}`);
      }

      try {
        console.log(`🔍 useAvailableBundles - Making API call:`, {
          endpoint,
          tenantId,
          userRole: user.currentRole
        });
        
        // Exclude hidden products when fetching for enrollment (agent endpoint returns them by default)
        const url = endpoint.includes('/api/me/agent/products') ? `${endpoint}?includeHidden=false` : endpoint;
        const response = await apiService.get<{ success: boolean; data: Bundle[] }>(url);
        
        console.log(`🔍 useAvailableBundles - API response:`, {
          endpoint,
          success: response.success,
          dataLength: response.data?.length || 0
        });
        
        if (response.success && response.data) {
          console.log('🔍 useAvailableBundles - Raw API data sample:', response.data[0]);
          
          // Filter to only return bundles (IsBundle = 1 or true), active, and non-hidden
          const bundles = response.data.filter(product => {
            const isBundle = product.IsBundle === 1 || product.IsBundle === true;
            const isActive = product.Status === 'Active';
            const isHidden = (product as any).IsHidden === 1 || (product as any).IsHidden === true;
            return isBundle && isActive && !isHidden;
          });
          
          console.log('🔍 useAvailableBundles - Filtered bundles sample:', bundles[0]);
          
          return bundles;
        }
        
        return [];
      } catch (error) {
        console.warn(`Error fetching bundles from ${endpoint}:`, error);
        return [];
      }
    },
    enabled: !isAuthLoading && !!user?.currentRole && (user.currentRole !== 'SysAdmin' || !!tenantId),
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};