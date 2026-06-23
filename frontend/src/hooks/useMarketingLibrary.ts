import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { MarketingResourcesService } from '../services/marketing-resources.service';

export const marketingLibraryKeys = {
  all: ['marketing-library'] as const,
  tree: (role: string, tenantId?: string | null) =>
    [...marketingLibraryKeys.all, 'tree', role, tenantId ?? 'no-tenant'] as const,
  tenantAdminAgencyTree: (tenantId: string | null | undefined, agencyId: string) =>
    [...marketingLibraryKeys.all, 'tenant-admin-agency', tenantId ?? 'no-tenant', agencyId] as const
};

export function useMarketingLibraryTree() {
  const { user, isLoading: authLoading } = useAuth();
  const role = user?.currentRole || '';
  const tenantId = user?.currentTenantId ?? user?.tenantId ?? '';

  return useQuery({
    queryKey: marketingLibraryKeys.tree(role, tenantId),
    queryFn: () => MarketingResourcesService.getResourceLibraryPayload(role),
    enabled: !authLoading && (role === 'TenantAdmin' || role === 'SysAdmin' || role === 'Agent'),
    staleTime: 60 * 1000
  });
}

/**
 * Tenant admin (or sysadmin via tenant switch) viewing/managing a specific
 * agency's marketing library inside their tenant.
 */
export function useTenantAdminAgencyLibrary(agencyId: string | null) {
  const { user, isLoading: authLoading } = useAuth();
  const role = user?.currentRole || '';
  const tenantId = user?.currentTenantId ?? user?.tenantId ?? '';

  return useQuery({
    queryKey: marketingLibraryKeys.tenantAdminAgencyTree(tenantId, agencyId || ''),
    queryFn: () => MarketingResourcesService.getTenantAdminAgencyLibrary(agencyId as string),
    enabled:
      !authLoading &&
      !!agencyId &&
      (role === 'TenantAdmin' || role === 'SysAdmin'),
    staleTime: 60 * 1000
  });
}
