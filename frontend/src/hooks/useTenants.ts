import { useQuery } from '@tanstack/react-query';
import { apiService } from '../services/api.service';

interface Tenant {
  TenantId: string;
  Name: string;
  ContactEmail: string;
  Status: string;
  LogoUrl?: string;
  CreatedDate?: string;
  LastModifiedDate?: string;
}

interface TenantsResponse {
  success: boolean;
  data: Tenant[];
  message?: string;
  error?: {
    message: string;
    code: string;
  };
}

const fetchTenants = async (enabled?: boolean): Promise<Tenant[]> => {
  try {
    const response = await apiService.get<TenantsResponse>('/api/tenants');
    
    if (response.success) {
      return response.data;
    } else {
      throw new Error(response.message || 'Failed to fetch tenants');
    }
  } catch (error) {
    console.error('Error fetching tenants:', error);
    throw new Error(error instanceof Error ? error.message : 'Failed to fetch tenants');
  }
};

export const useTenants = (enabled: boolean = true) => {
  return useQuery({
    queryKey: ['tenants'],
    queryFn: () => fetchTenants(enabled),
    enabled,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 2,
  });
};