// frontend/src/hooks/useGroupOnboardingProducts.ts
import { useQuery } from '@tanstack/react-query';
import type { ApiResponse } from '../types/api.types';

export interface GroupOnboardingProduct {
  GroupProductId: string;
  GroupId: string;
  ProductId: string;
  Name: string;
  ProductType: string;
  Description?: string;
  BasePrice: number;
  ProductLogoUrl?: string;
  ProductImageUrl?: string;
  ProductDocumentUrl?: string;
  MinAge: number;
  MaxAge: number;
  SalesType: string;
  AllowedStates: string[];
  RequiredASA?: string;
  ProductOwner: string;
  IsAssigned: boolean;
  IsActive: boolean;
}

export interface GroupOnboardingProductsResponse {
  groupProducts: GroupOnboardingProduct[];
  availableProducts: GroupOnboardingProduct[];
}

/**
 * Hook to fetch products for a group during onboarding (public endpoint)
 * @param linkToken The onboarding link token
 */
export const useGroupOnboardingProducts = (linkToken: string | undefined) => {
  return useQuery({
    queryKey: ['groupOnboardingProducts', linkToken],
    queryFn: async (): Promise<GroupOnboardingProductsResponse> => {
      if (!linkToken) {
        throw new Error('Link token is required');
      }

      try {
        // Use the public onboarding endpoint through apiService
        const { apiService } = await import('../services/api.service');
        const data = await apiService.get<ApiResponse<GroupOnboardingProductsResponse>>(`/api/group-onboarding/${linkToken}/products`);
        
        if (!data.success) {
          throw new Error(data.message || 'Failed to fetch group products');
        }

        return data.data!;
      } catch (error) {
        console.error('Error fetching group onboarding products:', error);
        throw error;
      }
    },
    enabled: !!linkToken,
    retry: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
};
