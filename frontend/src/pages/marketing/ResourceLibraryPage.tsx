import React, { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Building, Building2, Copy, Loader2 } from 'lucide-react';
import MarketingDocumentsTab from '../../components/marketing/MarketingDocumentsTab';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';

interface AgencyOption {
  AgencyId: string;
  AgencyName: string;
}

interface AgenciesResponse {
  success: boolean;
  data?: AgencyOption[];
  message?: string;
}

interface TenantOption {
  TenantId: string;
  Name: string;
}

interface TenantsResponse {
  success: boolean;
  data?: TenantOption[];
  message?: string;
}

const ORG_VALUE = '__org__';

const ResourceLibraryPage: React.FC = () => {
  const { user, switchTenant } = useAuth();
  const role = user?.currentRole || '';
  const isAdmin = role === 'TenantAdmin' || role === 'SysAdmin';
  const isSysAdmin = role === 'SysAdmin';
  const tenantId = user?.currentTenantId ?? user?.tenantId ?? '';

  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(false);
  const [tenantsError, setTenantsError] = useState<string | null>(null);

  const [agencies, setAgencies] = useState<AgencyOption[]>([]);
  const [agenciesLoading, setAgenciesLoading] = useState(false);
  const [agenciesError, setAgenciesError] = useState<string | null>(null);
  const [selectedAgencyId, setSelectedAgencyId] = useState<string>(ORG_VALUE);

  useEffect(() => {
    if (!isSysAdmin) return;
    let cancelled = false;
    const load = async () => {
      try {
        setTenantsLoading(true);
        setTenantsError(null);
        const res = await apiService.get<TenantsResponse>('/api/tenants?lightweight=true');
        if (cancelled) return;
        if (res.success && Array.isArray(res.data)) {
          setTenants([...res.data].sort((a, b) => (a.Name || '').localeCompare(b.Name || '')));
        } else {
          setTenantsError(res.message || 'Failed to load tenants');
        }
      } catch (err) {
        if (!cancelled) setTenantsError(err instanceof Error ? err.message : 'Failed to load tenants');
      } finally {
        if (!cancelled) setTenantsLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [isSysAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    const load = async () => {
      try {
        setAgenciesLoading(true);
        setAgenciesError(null);
        const res = await apiService.get<AgenciesResponse>('/api/me/tenant-admin/agencies');
        if (cancelled) return;
        if (res.success && Array.isArray(res.data)) {
          setAgencies(
            [...res.data].sort((a, b) => (a.AgencyName || '').localeCompare(b.AgencyName || ''))
          );
        } else {
          setAgenciesError(res.message || 'Failed to load agencies');
        }
      } catch (err) {
        if (!cancelled) setAgenciesError(err instanceof Error ? err.message : 'Failed to load agencies');
      } finally {
        if (!cancelled) setAgenciesLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, tenantId]);

  useEffect(() => {
    setSelectedAgencyId(ORG_VALUE);
  }, [tenantId]);

  const selectedAgency = useMemo(
    () => agencies.find((a) => a.AgencyId === selectedAgencyId) || null,
    [agencies, selectedAgencyId]
  );

  const tenantAdminAgencyContext =
    isAdmin && selectedAgency
      ? { agencyId: selectedAgency.AgencyId, agencyName: selectedAgency.AgencyName }
      : null;

  const handleTenantChange = (nextTenantId: string) => {
    if (!nextTenantId || nextTenantId === tenantId) return;
    switchTenant(nextTenantId);
  };

  return (
    <div className="p-6 space-y-4">
      {isSysAdmin && (
        <div className="flex justify-end">
          <RouterLink
            to="/admin/marketing-resources/copy"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium"
          >
            <Copy className="h-4 w-4" />
            Copy folders to another tenant
          </RouterLink>
        </div>
      )}

      {isSysAdmin && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 flex flex-col md:flex-row md:items-center gap-3">
          <label htmlFor="rl-tenant-select" className="text-sm font-medium text-gray-700 flex items-center gap-2">
            <Building className="h-4 w-4 text-gray-500" />
            Tenant
          </label>
          <select
            id="rl-tenant-select"
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm md:flex-1 max-w-md"
            value={tenantId}
            onChange={(e) => handleTenantChange(e.target.value)}
            disabled={tenantsLoading}
          >
            {tenants.length === 0 && tenantId && <option value={tenantId}>Current tenant</option>}
            {tenants.map((t) => (
              <option key={t.TenantId} value={t.TenantId}>
                {t.Name}
              </option>
            ))}
          </select>
          {tenantsLoading && (
            <span className="text-xs text-gray-500 inline-flex items-center gap-1">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading tenants…
            </span>
          )}
          {tenantsError && <span className="text-xs text-red-600">{tenantsError}</span>}
          <span className="text-xs text-gray-500 md:ml-auto">
            Switching tenant reloads the page so the rest of the app stays in sync.
          </span>
        </div>
      )}

      {isAdmin && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 flex flex-col md:flex-row md:items-center gap-3">
          <label htmlFor="rl-agency-select" className="text-sm font-medium text-gray-700 flex items-center gap-2">
            <Building2 className="h-4 w-4 text-gray-500" />
            Library
          </label>
          <select
            id="rl-agency-select"
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm md:flex-1 max-w-md"
            value={selectedAgencyId}
            onChange={(e) => setSelectedAgencyId(e.target.value)}
            disabled={agenciesLoading}
          >
            <option value={ORG_VALUE}>Tenant (organization) library</option>
            {agencies.map((a) => (
              <option key={a.AgencyId} value={a.AgencyId}>
                Agency: {a.AgencyName}
              </option>
            ))}
          </select>
          {agenciesLoading && (
            <span className="text-xs text-gray-500 inline-flex items-center gap-1">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading agencies…
            </span>
          )}
          {agenciesError && <span className="text-xs text-red-600">{agenciesError}</span>}
          <span className="text-xs text-gray-500 md:ml-auto">
            {selectedAgencyId === ORG_VALUE
              ? 'Editing the tenant-wide library shown to all agents (unless their agency uses its own library).'
              : 'Editing this agency’s private library; toggle "Use agency-only resource library" below to control visibility.'}
          </span>
        </div>
      )}

      <MarketingDocumentsTab tenantAdminAgencyContext={tenantAdminAgencyContext} />
    </div>
  );
};

export default ResourceLibraryPage;
