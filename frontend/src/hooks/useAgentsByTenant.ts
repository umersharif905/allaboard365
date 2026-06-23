// frontend/src/hooks/useAgentsByTenant.ts
import { useQuery } from '@tanstack/react-query';
import AgentService from '../services/agent/agent.service';
import { ApiResponse } from '../types/index';

/**
 * Hook to fetch agents for a specific tenant.
 * @param {string | null} tenantId - The ID of the tenant.
 * @param {boolean} enabled - Whether the query should be enabled (defaults to !!tenantId).
 * @param {string} search - Optional search query for server-side filtering (name/email).
 * @param {string} includeUserId - When provided (e.g. edit mode), backend ensures this agent is in results even if inactive.
 */
export const useAgentsByTenant = (tenantId: string | null, enabled?: boolean, search?: string, includeUserId?: string) => {
    return useQuery<ApiResponse<any[]>, Error, any[]>({
        queryKey: ['agentsByTenant', tenantId, search ?? '', includeUserId ?? ''],
        queryFn: () => {
            if (!tenantId) {
                return Promise.resolve({ success: true, data: [] });
            }
            return AgentService.getAgentsByTenant(tenantId, { search: search || undefined, includeUserId: includeUserId || undefined });
        },
        enabled: enabled !== undefined ? enabled : !!tenantId,
        select: (response) => {
            if (response.success && response.data) {
                return response.data;
            }
            return [];
        },
        // Keep previous options when search clears (dropdown close) so selected agent stays visible
        placeholderData: (previousData) => previousData,
    });
}; 