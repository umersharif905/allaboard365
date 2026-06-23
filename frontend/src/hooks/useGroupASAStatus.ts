import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { GroupASAStatusService } from '../services/group-asa-status.service';

/**
 * Hook to get ASA signature status for all products in a group
 * @param groupId The ID of the group
 */
export const useGroupASAStatus = (groupId: string | undefined) => {
  const { user, isLoading: isAuthLoading } = useAuth();
  
  return useQuery({
    queryKey: ['groupASAStatus', groupId],
    queryFn: async () => {
      if (!groupId) {
        throw new Error('Group ID is required');
      }
      
      const response = await GroupASAStatusService.getGroupASAStatus(groupId);
      
      if (!response.success) {
        throw new Error(response.message || 'Failed to fetch ASA status');
      }
      
      return response.data;
    },
    enabled: !isAuthLoading && !!user && !!groupId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 1
  });
};

/**
 * Hook to get ASA signature status for a specific product in a group
 * @param groupId The ID of the group
 * @param productId The ID of the product
 */
export const useProductASAStatus = (groupId: string | undefined, productId: string | undefined) => {
  const { user, isLoading: isAuthLoading } = useAuth();
  
  return useQuery({
    queryKey: ['productASAStatus', groupId, productId],
    queryFn: async () => {
      if (!groupId || !productId) {
        throw new Error('Group ID and Product ID are required');
      }
      
      const response = await GroupASAStatusService.getProductASAStatus(groupId, productId);
      
      if (!response.success) {
        throw new Error(response.message || 'Failed to fetch product ASA status');
      }
      
      return response.data;
    },
    enabled: !isAuthLoading && !!user && !!groupId && !!productId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 1
  });
};

/**
 * Hook to get products that require ASA signatures but haven't been signed yet
 * @param groupId The ID of the group
 */
export const usePendingASAProducts = (groupId: string | undefined) => {
  const { data: asaStatus, isLoading, isError, error } = useGroupASAStatus(groupId);
  
  const pendingProducts = asaStatus?.products.filter(product => 
    product.requiresASA && !product.isSigned
  ) || [];
  
  return {
    data: pendingProducts,
    isLoading,
    isError,
    error,
    count: pendingProducts.length
  };
};

/**
 * Hook to get products that have been signed
 * @param groupId The ID of the group
 */
export const useSignedASAProducts = (groupId: string | undefined) => {
  const { data: asaStatus, isLoading, isError, error } = useGroupASAStatus(groupId);
  
  const signedProducts = asaStatus?.products.filter(product => 
    product.requiresASA && product.isSigned
  ) || [];
  
  return {
    data: signedProducts,
    isLoading,
    isError,
    error,
    count: signedProducts.length
  };
};
