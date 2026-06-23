// frontend/src/hooks/useGroupAgent.ts
import { useQuery } from '@tanstack/react-query';
import GroupsService from '../services/groups.service';

/**
 * Hook to fetch the assigned agent for a specific group.
 * @param {string | null} groupId - The ID of the group.
 */
export const useGroupAgent = (groupId: string | null) => {
    return useQuery({
        queryKey: ['groupAgent', groupId],
        queryFn: () => {
            if (!groupId) {
                return Promise.resolve(null);
            }
            return GroupsService.getGroupAgent(groupId);
        },
        enabled: !!groupId,
        select: (response) => {
            if (response && response.success) {
                return response.data;
            }
            return null;
        },
    });
}; 