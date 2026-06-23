import { useQuery } from '@tanstack/react-query';
import { billingDriftService, type BillingDriftResponse } from '../services/billingDrift.service';

export function useBillingDrift(params: { enabled?: boolean; since?: string; limit?: number; minDrift?: number } = {}) {
  const { enabled = true, ...rest } = params;
  return useQuery<BillingDriftResponse>({
    queryKey: ['billing-drift', rest],
    queryFn: () => billingDriftService.list(rest),
    enabled,
    staleTime: 60_000
  });
}
