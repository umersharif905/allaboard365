// frontend/src/hooks/useGroupProducts.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GroupProductsService, GroupProductUpdate } from '../services/group-products.service';

/**
 * Hook to fetch products for a specific group
 * @param groupId The ID of the group
 */
export const useGroupProducts = (
  groupId: string | undefined,
  options?: { includeHidden?: boolean }
) => {
  const includeHidden = options?.includeHidden === true;
  return useQuery({
    queryKey: ['groupProducts', groupId, includeHidden],
    queryFn: async () => {
      if (!groupId) {
        throw new Error('Group ID is required');
      }
      try {
        const response = await GroupProductsService.getGroupProducts(groupId, {
          includeHidden
        });
        if (!response.success) {
          // If the error is about group access, return empty data with a flag
          if (response.message === 'Group not found or access denied') {
            return { 
              groupProducts: [], 
              availableProducts: [],
              accessDenied: true,
              message: response.message
            };
          }
          throw new Error(response.message || 'Failed to fetch group products');
        }
        return response.data;
      } catch (error) {
        // If the error is a 404 (route not found), return empty data with a flag
        if (error instanceof Error && 
            (error.message.includes('404') || 
             error.message.includes('Group not found') || 
             error.message.includes('access denied'))) {
          return { 
            groupProducts: [], 
            availableProducts: [],
            routeNotFound: error.message.includes('404'),
            accessDenied: error.message.includes('access denied') || error.message.includes('Group not found'),
            message: error.message
          };
        }
        throw error;
      }
    },
    enabled: !!groupId,
    retry: false, // Don't retry on failure to avoid multiple error messages
  });
};

/**
 * Hook to update product assignments for a group
 * @param groupId The ID of the group
 */
export const useUpdateGroupProducts = (groupId: string | undefined) => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (updates: GroupProductUpdate[]) => {
      if (!groupId) {
        throw new Error('Group ID is required');
      }
      try {
        const response = await GroupProductsService.updateGroupProducts(groupId, updates);
        if (!response.success) {
          throw new Error(response.message || 'Failed to update group products');
        }
        return response.data;
      } catch (error) {
        // If the error is a 404 (route not found), handle gracefully
        if (error instanceof Error && 
            (error.message.includes('404') || 
             error.message.includes('Group not found') || 
             error.message.includes('access denied'))) {
          return { 
            message: 'Product assignments feature not available or access denied',
            routeNotFound: error.message.includes('404'),
            accessDenied: error.message.includes('access denied') || error.message.includes('Group not found')
          };
        }
        throw error;
      }
    },
    onSuccess: () => {
      // Invalidate and refetch the group products query
      queryClient.invalidateQueries({ queryKey: ['groupProducts', groupId] });
    },
  });
}; 