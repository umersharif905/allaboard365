import { useQuery } from '@tanstack/react-query';
import { apiService, withTenantScope } from '../../services/api.service';

export interface PlanTenureChainEntry {
  enrollmentId: string;
  productId: string | null;
  productName: string | null;
  effectiveDate: string | null;
  terminationDate: string | null;
  status: string;
}

export interface PlanTenure {
  hasCoverage: boolean;
  tenureStartDate: string | null;
  daysOnPlan: number;
  chain: PlanTenureChainEntry[];
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
}

export function useMemberPlanTenure(
  memberId: string | undefined,
  tenantId?: string | null,
  options?: { enabled?: boolean }
) {
  const enabled = options?.enabled ?? true;
  return useQuery({
    queryKey: ['member-plan-tenure', memberId, tenantId],
    queryFn: () =>
      apiService.get<ApiResponse<PlanTenure>>(
        `/api/enrollments/tenure/${memberId}`,
        withTenantScope(tenantId)
      ),
    select: (resp): PlanTenure | null => resp.data || null,
    enabled: !!memberId && enabled
  });
}
