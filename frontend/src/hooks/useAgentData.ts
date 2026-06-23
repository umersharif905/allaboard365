// frontend/src/hooks/useAgentData.ts
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import AgentService from '../services/agent/agent.service';
import { User } from '../types/user.types';

/**
 * Hook to fetch the current agent's specific data.
 */
export const useAgentData = () => {
    const { user, isLoading } = useAuth();
    const typedUser = user as User | null;

    return useQuery({
        queryKey: ['agentData', typedUser?.userId],
        queryFn: () => {
            if (!typedUser) {
                return Promise.reject(new Error('User not authenticated'));
            }
            return AgentService.getAgentDataFromUserId(typedUser.userId);
        },
        enabled: !isLoading && !!typedUser && typedUser.currentRole === 'Agent',
        select: (response) => {
            if (response.success) {
                return response.data;
            }
            return null;
        },
    });
}; 