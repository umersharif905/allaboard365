// frontend/src/hooks/useGroupDetails.ts
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { Group, GroupsService } from '../services/groups.service';

/**
 * Custom hook to fetch group details.
 * It intelligently decides which API endpoint to use based on the user's role.
 * - GroupAdmin: Fetches their own assigned group.
 * - Agent: Fetches group details for a group they manage.
 * - SysAdmin/TenantAdmin: Fetches group by ID from URL params.
 *
 * @param groupId The group ID from the URL, required for Admin and Agent roles.
 */
export const useGroupDetails = (groupId?: string, options?: { enabled?: boolean }) => {
    const { user, isLoading: isAuthLoading } = useAuth();

    const fetchGroupData = async (): Promise<Group> => {
        if (!user) {
            throw new Error("Authentication required.");
        }

        let response;
        if (user.currentRole === 'GroupAdmin') {
            response = await GroupsService.getMyGroupAdminGroup();
        } else if (user.currentRole === 'Agent') {
            if (!groupId) {
                throw new Error("Group ID is required for agents.");
            }
            response = await GroupsService.getAgentGroup(groupId);
        } else if (user.currentRole === 'SysAdmin' || user.currentRole === 'TenantAdmin') {
            if (!groupId) {
                throw new Error("Group ID is required for admins.");
            }
            response = await GroupsService.getGroupById(groupId);
        } else {
            throw new Error("You do not have permission to view group details.");
        }

        if (response.success && response.data) {
            if (user.currentRole === 'TenantAdmin' && response.data.TenantId !== user.tenantId) {
                console.error(`[useGroupDetails] !! Tenant Mismatch: User's tenant (${user.tenantId}) does not match group's tenant (${response.data.TenantId}).`);
                throw new Error("Access denied. This group does not belong to your organization.");
            }
            return response.data;
        }
        
        throw new Error(response.message || 'Failed to fetch group details.');
    };

    const isHookEnabled = !isAuthLoading && !!user;
    const enabled = options?.enabled !== false && isHookEnabled && (!!groupId || user?.currentRole === 'GroupAdmin');

    return useQuery<Group, Error>({
        queryKey: ['groupDetails', groupId],
        queryFn: fetchGroupData,
        enabled,
        retry: 1,
        staleTime: 60_000, // 1 min - avoid refetch on every tab switch/mount
        refetchOnMount: false, // Use cache when not stale; refetch only when stale
        refetchOnWindowFocus: false, // Avoid refetch on tab focus (user may have many tabs)
    });
}; 