// frontend/src/hooks/useMyTenant.ts
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import TenantService from '../services/tenant.service';
import { User } from '../types/user.types';

/**
 * Hook to fetch the current user's tenant details based on their role.
 * @param {boolean} enabled - Whether the query should be enabled.
 */
export const useMyTenant = (enabled: boolean) => {
    const { user, isLoading } = useAuth();
    const typedUser = user as User | null;

    return useQuery({
        queryKey: ['myTenant', typedUser?.userId],
        queryFn: () => {
            if (!typedUser) {
                // This should not happen if enabled is managed correctly
                return Promise.reject(new Error('User not authenticated'));
            }
            return TenantService.getMyTenant(typedUser);
        },
        enabled: !isLoading && !!typedUser && enabled && typedUser.currentRole !== 'SysAdmin',
        select: (response) => {
            if (response.success) {
                return response.data;
            }
            return null;
        },
        retry: 1,
    });
}; 