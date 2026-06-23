import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { CommissionLevel } from '../services/tenant-admin/agents.service';
import { useAuth } from '../contexts/AuthContext';
import { apiService, resolveTenantScopeId, withExplicitTenantScope } from '../services/api.service';

/**
 * Shared loader for the active tenant's oe.CommissionLevels.
 *
 * Uses the same active-tenant resolution as api.service (x-current-tenant-id /
 * localStorage currentTenantId / SysAdmin agents picker). Keyed by tenant so
 * a tenant switch invalidates the cache automatically.
 *
 * Returns:
 *   - `levels`: full CommissionLevel[] (sorted by SortOrder asc).
 *   - `displayNameByLevel`: SortOrder → DisplayName Map for tier-row labels.
 *   - `isLoading`: query state.
 *   - `meta`: { commissionLevelsHybridEnabled?, useCustomCommissionLevelsOnly? }.
 *   - `tenantId`: resolved active tenant id used for the query (null if none).
 */
export function useCommissionLevels(opts?: {
  includeInactive?: boolean;
  /** Override active tenant (e.g. SysAdmin /admin/agents picker, rule wizard tenant field). */
  tenantId?: string | null;
}) {
  const includeInactive = opts?.includeInactive === true;
  const { user } = useAuth();
  const explicitTenantId =
    opts?.tenantId != null && String(opts.tenantId).trim() !== ''
      ? String(opts.tenantId).trim()
      : null;
  /** Active tenant — header + cache key (see prompts/backend-system.md). */
  const tenantId = resolveTenantScopeId(explicitTenantId);

  const query = useQuery({
    queryKey: ['commission-levels', tenantId, includeInactive],
    enabled: !!user && !!tenantId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (includeInactive) params.set('includeInactive', 'true');
      if (tenantId) params.set('tenantId', tenantId);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const resp = await apiService.get<{
        success?: boolean;
        data?: CommissionLevel[];
        meta?: Record<string, unknown>;
      }>(`/api/tenant-admin/commission-levels${qs}`, withExplicitTenantScope(tenantId));
      if (!resp?.success || !Array.isArray(resp.data)) {
        return { levels: [] as CommissionLevel[], meta: resp?.meta || {} };
      }
      const sorted = [...resp.data].sort((a, b) => Number(a.SortOrder ?? 0) - Number(b.SortOrder ?? 0));
      return { levels: sorted, meta: resp.meta || {} };
    }
  });

  const displayNameByLevel = useMemo(() => {
    const map = new Map<number, string>();
    for (const lvl of query.data?.levels || []) {
      if (lvl?.SortOrder != null && lvl?.DisplayName) {
        map.set(Number(lvl.SortOrder), String(lvl.DisplayName));
      }
    }
    return map;
  }, [query.data?.levels]);

  return {
    levels: query.data?.levels || [],
    displayNameByLevel,
    meta: query.data?.meta || {},
    tenantId,
    isLoading: query.isLoading
  };
}
