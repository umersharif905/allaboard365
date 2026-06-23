// frontend/src/hooks/useGroupMembers.ts
import { useQuery } from '@tanstack/react-query';
import { GroupsService, type GroupMembersQueryParams, type GroupMembersResponse } from '../services/groups.service';
import { ApiResponse } from '../types/api.types';

/**
 * Hook to fetch members for a specific group with server-side pagination and sorting.
 * @param groupId The ID of the group to fetch members for.
 * @param params Pagination and sorting parameters
 */
export const useGroupMembers = (groupId: string | undefined, params?: GroupMembersQueryParams) => {
  return useQuery<ApiResponse<GroupMembersResponse>, Error, GroupMembersResponse>({
    queryKey: ['groupMembers', groupId, params?.page, params?.pageSize, params?.sortBy, params?.sortOrder, params?.locationFilter, params?.showTerminated, params?.showInactive, params?.search, params?.enrollmentStatusFilter], // Individual params for reactivity
    queryFn: () => {
      if (!groupId) {
        throw new Error('Group ID is required');
      }
      return GroupsService.getGroupMembers(groupId, params);
    },
    enabled: !!groupId,
    staleTime: 30_000, // 30s - avoid refetch on every tab switch
    select: (response) => {
      if (response.success && response.data) {
        return {
          members: response.data.members,
          statusCounts: response.data.statusCounts,
          enrollmentSummary: response.data.enrollmentSummary ?? { totalPremium: 0, enrolledHouseholdsCount: 0, futureEffectiveHouseholdsCount: 0, totalHouseholdsCount: 0 },
          pagination: response.data.pagination ?? {
            page: params?.page ?? 1,
            pageSize: params?.pageSize ?? 10,
            totalCount: response.data.members.length,
            totalPages: 1,
          },
        };
      }
      return { 
        members: [], 
        statusCounts: {},
        enrollmentSummary: { totalPremium: 0, enrolledHouseholdsCount: 0, futureEffectiveHouseholdsCount: 0, totalHouseholdsCount: 0 },
        pagination: {
          page: 1,
          pageSize: 10,
          totalCount: 0,
          totalPages: 0
        }
      };
    },
  });
}; 