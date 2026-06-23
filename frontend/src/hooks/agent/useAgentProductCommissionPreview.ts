import { useQuery } from '@tanstack/react-query';
import { apiService } from '../../services/api.service';

export interface CommissionPreviewRow {
  levelSortOrder: number;
  label: string;
  isAgentLevel: boolean;
  payoutMode: 'flat' | 'percent';
  flatAmount: number | null;
  percentLabel: string | null;
  familyFlat: Record<string, number> | null;
  familyPercent: Record<string, string | null> | null;
}

export interface AgentProductCommissionPreview {
  hasPayout: boolean;
  message: string | null;
  agentsCanViewOtherCommissionLevels: boolean;
  agentLevel: { sortOrder: number; displayName: string };
  ruleName: string | null;
  ruleSource: 'product' | 'allProducts' | null;
  rows: CommissionPreviewRow[];
  /** Resolved group name (tenant preview with selected group). */
  commissionGroupName?: string | null;
  viewerRole?: 'tenant' | 'agent' | 'downlineAgent';
  /** Downline preview: display name of the selected downline agent. */
  subjectAgentName?: string | null;
}

export interface UseAgentProductCommissionPreviewOptions {
  /** When true, API requires commissionGroupId query (tenant / sysadmin path). */
  tenantViewer?: boolean;
  commissionGroupId?: string | null;
  /** When set, preview the commission group for this downline agent (upline viewer). */
  downlineAgentId?: string | null;
}

export const useAgentProductCommissionPreview = (
  productId: string | null,
  active: boolean,
  options?: UseAgentProductCommissionPreviewOptions
) => {
  const tenantViewer = options?.tenantViewer === true;
  const commissionGroupId = options?.commissionGroupId ?? null;
  const downlineAgentId = options?.downlineAgentId?.trim() || null;

  const enabled =
    !!productId &&
    active &&
    (!tenantViewer || (commissionGroupId != null && String(commissionGroupId).trim() !== ''));

  return useQuery<AgentProductCommissionPreview, Error>({
    queryKey: [
      'agentProductCommissionPreview',
      productId,
      tenantViewer ? commissionGroupId : (downlineAgentId || 'agent')
    ],
    queryFn: async () => {
      if (!productId) throw new Error('Product ID is required');
      const qs =
        tenantViewer && commissionGroupId
          ? `?commissionGroupId=${encodeURIComponent(String(commissionGroupId).trim())}`
          : downlineAgentId && !tenantViewer
            ? `?downlineAgentId=${encodeURIComponent(downlineAgentId)}`
            : '';
      const res = await apiService.get<{ success: boolean; data?: AgentProductCommissionPreview; message?: string }>(
        `/api/me/agent/products/${productId}/commission-preview${qs}`
      );
      if (!res.success || !res.data) {
        throw new Error(res.message || 'Failed to load commission preview');
      }
      return res.data;
    },
    enabled,
    staleTime: downlineAgentId ? 0 : 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 1
  });
};
