import { useQuery } from '@tanstack/react-query';
import { fetchMergedCommissionCapsMap } from '../utils/fetchProductCommissionAiEnrichment';
import { TierCommissionCapsMap } from '../utils/productCommissionPoolCaps';

const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';

export function useProductCommissionPoolCaps(productId: string | undefined | null) {
  const enabled =
    Boolean(productId) &&
    String(productId).trim() !== '' &&
    String(productId).toLowerCase() !== ALL_PRODUCTS_GUID;

  const query = useQuery({
    queryKey: ['product-commission-pool-caps', productId],
    enabled,
    queryFn: () => fetchMergedCommissionCapsMap(String(productId)),
    staleTime: 60_000,
  });

  return {
    caps: query.data ?? ({} as TierCommissionCapsMap),
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isFetched: query.isFetched,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}
