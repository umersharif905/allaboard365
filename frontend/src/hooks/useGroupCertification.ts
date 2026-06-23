// frontend/src/hooks/useGroupCertification.ts
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api.service';

export interface GroupCertification {
  agentSignedAt: string | null;
  agentHasSignature: boolean;
  groupAdminSignedAt: string | null;
  groupAdminHasSignature: boolean;
  signaturesRequired?: boolean;
}

/**
 * Shared hook for New Group Form certification (agent + group admin signatures).
 * Used by GroupDetails and useGroupSetupStatus to avoid duplicate fetches.
 */
export const useGroupCertification = (groupId: string | undefined) => {
  const { user, isLoading: isAuthLoading } = useAuth();

  return useQuery({
    queryKey: ['groupCertification', groupId],
    queryFn: async (): Promise<GroupCertification | null> => {
      if (!groupId) return null;
      const res = await apiService.get<{ success: boolean; data?: GroupCertification }>(
        `/api/groups/${groupId}/new-group-form/certification`
      );
      return res?.success && res?.data ? res.data : null;
    },
    enabled: !isAuthLoading && !!user && !!groupId,
    staleTime: 60_000, // 1 min - match useGroupDetails
    refetchOnWindowFocus: false,
  });
};
