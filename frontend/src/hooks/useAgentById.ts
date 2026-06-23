// frontend/src/hooks/useAgentById.ts
import { useQuery } from '@tanstack/react-query';
import AgentService from '../services/agent/agent.service';

/**
 * Hook to fetch a single agent by their ID.
 * @param {string | null} agentId - The ID of the agent to fetch.
 */
export const useAgentById = (agentId: string | null) => {
    return useQuery({
        queryKey: ['agentById', agentId],
        queryFn: () => {
            if (!agentId) {
                return Promise.resolve(null);
            }
            // We need a new service method for this
            return AgentService.getAgentById(agentId);
        },
        enabled: !!agentId,
        select: (response) => {
            if (response && response.success) {
                return response.data;
            }
            return null;
        },
    });
}; 