import { useQuery } from '@tanstack/react-query';
import { apiService } from '../services/api.service';

interface Vendor {
  Id: string;
  VendorName: string;
  ContactName?: string;
  Email?: string;
  Phone?: string;
  City?: string;
  State?: string;
  Status?: string;
  CreatedDate?: string;
  LastModifiedDate?: string;
}

interface VendorsResponse {
  success: boolean;
  data: Vendor[];
  message?: string;
  error?: {
    message: string;
    code: string;
  };
}

const fetchVendors = async (): Promise<Vendor[]> => {
  try {
    const response = await apiService.get<VendorsResponse>('/api/vendors');
    
    if (response.success) {
      return response.data;
    } else {
      throw new Error(response.message || 'Failed to fetch vendors');
    }
  } catch (error) {
    console.error('Error fetching vendors:', error);
    throw new Error(error instanceof Error ? error.message : 'Failed to fetch vendors');
  }
};

export const useVendors = () => {
  return useQuery({
    queryKey: ['vendors'],
    queryFn: fetchVendors,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 2,
  });
};
