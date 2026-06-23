// frontend/src/hooks/groups/useGroupProductEnrollmentCount.ts
import { useQuery } from '@tanstack/react-query';
import { getEnrollmentCount } from '../../services/group-products.service';

export function useGroupProductEnrollmentCount(
  groupId: string,
  productId: string | null
) {
  return useQuery({
    queryKey: ['group-product-enrollment-count', groupId, productId],
    queryFn: () => getEnrollmentCount(groupId, productId!),
    enabled: !!productId,
    staleTime: 0,
  });
}
