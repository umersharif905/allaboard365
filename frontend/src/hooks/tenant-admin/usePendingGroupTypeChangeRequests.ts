import { useQuery } from '@tanstack/react-query';
import {
  GroupTypeChangeRequest,
  listRequests,
} from '../../services/groupTypeChangeRequests.service';

/**
 * Pending group type-change requests for TenantAdmin (or SysAdmin when crossTenant).
 * Shares the react-query cache with GroupTypeChangeRequests so counts stay in sync
 * after approve/deny actions.
 */
export const usePendingGroupTypeChangeRequests = (options?: {
  enabled?: boolean;
  crossTenant?: boolean;
}) => {
  const crossTenant = options?.crossTenant ?? false;
  const enabled = options?.enabled ?? true;

  const query = useQuery<GroupTypeChangeRequest[], Error>({
    queryKey: ['group-type-change-requests', 'Pending', crossTenant],
    queryFn: () => listRequests({ status: 'Pending' }),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const pendingRequests = query.data ?? [];

  return {
    ...query,
    pendingRequests,
    pendingCount: pendingRequests.length,
  };
};
