// frontend/src/hooks/groups/useHiddenProductsWithEnrollments.ts
import { useQuery } from '@tanstack/react-query';
import {
  getHiddenWithEnrollments,
  HiddenProductWithEnrollments,
} from '../../services/group-products.service';

export function useHiddenProductsWithEnrollments(
  groupId: string,
  enabled: boolean = true
) {
  return useQuery<HiddenProductWithEnrollments[]>({
    queryKey: ['group-hidden-with-enrollments', groupId],
    queryFn: () => getHiddenWithEnrollments(groupId),
    enabled: enabled && !!groupId,
    staleTime: 30_000,
  });
}
