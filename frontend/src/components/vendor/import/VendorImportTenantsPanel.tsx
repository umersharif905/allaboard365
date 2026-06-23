import React, { useCallback, useEffect, useState } from 'react';
import {
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import { apiService } from '../../../services/api.service';
import { API_CONFIG } from '../../../config/api';
import VendorCreateTenantModal from './VendorCreateTenantModal';

interface FormatPreset {
  slug: string;
  label: string;
}

interface TenantProductStats {
  productId: string;
  productName: string;
  relationships: string[];
  stats: {
    householdCount: number;
    groupCount: number;
  };
}

interface TenantDirectoryRow {
  tenantId: string;
  tenantName: string;
  isExternal: boolean;
  products: TenantProductStats[];
}

interface TenantDirectoryPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface TenantDirectoryResponse {
  success: boolean;
  data: TenantDirectoryRow[];
  pagination: TenantDirectoryPagination;
}

interface Props {
  vendorId: string;
}

const DEFAULT_PAGE_SIZE = 25;

const relationshipLabel = (relationships: string[]) => {
  if (relationships.includes('owner') && relationships.includes('subscription')) return 'Owner & subscribed';
  if (relationships.includes('subscription') && relationships.includes('enrollment')) return 'Subscribed & enrolled';
  if (relationships.includes('owner')) return 'Product owner';
  if (relationships.includes('subscription')) return 'Subscribed';
  if (relationships.includes('enrollment')) return 'Enrolled only';
  return 'Linked';
};

const VendorImportTenantsPanel: React.FC<Props> = ({ vendorId: _vendorId }) => {
  const [tenants, setTenants] = useState<TenantDirectoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [pagination, setPagination] = useState<TenantDirectoryPagination>({
    page: 1,
    limit: DEFAULT_PAGE_SIZE,
    total: 0,
    totalPages: 0,
  });
  const [presets, setPresets] = useState<FormatPreset[]>([]);
  const [exportFormatSlug, setExportFormatSlug] = useState('sharewell_default');
  const [exportIncludeTerminations, setExportIncludeTerminations] = useState(false);
  const [exportingTenantId, setExportingTenantId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    void apiService.get<{ success: boolean; data: FormatPreset[] }>('/api/me/vendor/import/format-presets')
      .then((r) => { if (r.success && r.data?.length) setPresets(r.data); })
      .catch(() => setPresets([{ slug: 'sharewell_default', label: 'ShareWELL Standard (24-col)' }]));
    void apiService.get<{ success: boolean; data: { defaultEligibilityFormatSlug?: string } }>(
      '/api/me/vendor/import/eligibility-format'
    )
      .then((r) => {
        if (r.success && r.data?.defaultEligibilityFormatSlug) {
          setExportFormatSlug(r.data.defaultEligibilityFormatSlug);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = searchInput.trim();
      setDebouncedSearch((prev) => {
        if (prev !== next) setPage(1);
        return next;
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [pageSize]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('search', debouncedSearch);
      params.set('page', String(page));
      params.set('limit', String(pageSize));

      const res = await apiService.get<TenantDirectoryResponse>(
        `/api/me/vendor/import/tenant-directory?${params.toString()}`
      );
      if (res.success) {
        setTenants(res.data || []);
        setPagination(
          res.pagination || {
            page,
            limit: pageSize,
            total: res.data?.length || 0,
            totalPages: 0,
          }
        );
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load tenants');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleExpanded = (tenantId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(tenantId)) next.delete(tenantId);
      else next.add(tenantId);
      return next;
    });
  };

  const totalHouseholds = (products: TenantProductStats[]) =>
    products.reduce((sum, p) => sum + (p.stats?.householdCount || 0), 0);

  const totalGroups = (products: TenantProductStats[]) =>
    products.reduce((sum, p) => sum + (p.stats?.groupCount || 0), 0);

  const showPagination = pagination.total > pageSize;
  const rangeStart = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
  const rangeEnd = Math.min(pagination.page * pagination.limit, pagination.total);

  const downloadTenantExport = async (tenantId: string) => {
    setExportingTenantId(tenantId);
    setExportError(null);
    try {
      const token = localStorage.getItem('accessToken') || localStorage.getItem('token');
      const base = API_CONFIG.BASE_URL;
      const params = new URLSearchParams({
        formatSlug: exportFormatSlug,
        includeTerminations: exportIncludeTerminations ? '1' : '0',
      });
      const res = await fetch(
        `${base}/api/me/vendor/import/tenants/${tenantId}/eligibility-export?${params}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      );
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(errBody.message || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const fileName = match?.[1] || 'tenant-eligibility.csv';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setExportError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExportingTenantId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search tenants or products…"
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary/30 focus:border-oe-primary"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={exportFormatSlug}
            onChange={(e) => setExportFormatSlug(e.target.value)}
            className="text-sm border border-gray-300 rounded-md px-2 py-2 bg-white max-w-[220px]"
            aria-label="Export file format"
          >
            {presets.map((p) => (
              <option key={p.slug} value={p.slug}>{p.label}</option>
            ))}
          </select>
          <label className="inline-flex items-center gap-1.5 text-sm text-gray-700 px-1">
            <input
              type="checkbox"
              checked={exportIncludeTerminations}
              onChange={(e) => setExportIncludeTerminations(e.target.checked)}
            />
            Include terminations
          </label>
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            className="text-sm border border-gray-300 rounded-md px-2 py-2 bg-white"
            aria-label="Results per page"
          >
            <option value={10}>10 per page</option>
            <option value={25}>25 per page</option>
            <option value={50}>50 per page</option>
            <option value={100}>100 per page</option>
          </select>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-oe-primary text-white rounded-md hover:bg-oe-primary-dark"
          >
            <Plus className="h-4 w-4" />
            New tenant
          </button>
        </div>
      </div>

      {exportError && (
        <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">{exportError}</div>
      )}

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-500 gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading tenants…
        </div>
      ) : tenants.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-gray-200 rounded-lg bg-gray-50">
          <Building2 className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-700 font-medium">
            {debouncedSearch ? 'No tenants match your search' : 'No tenants yet'}
          </p>
          {!debouncedSearch && (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-oe-primary text-white rounded-md hover:bg-oe-primary-dark"
            >
              <Plus className="h-4 w-4" />
              New tenant
            </button>
          )}
        </div>
      ) : (
        <>
          {showPagination && (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600">
              <p>
                Showing <span className="font-medium text-gray-900">{rangeStart}</span> to{' '}
                <span className="font-medium text-gray-900">{rangeEnd}</span> of{' '}
                <span className="font-medium text-gray-900">{pagination.total}</span> tenants
              </p>
              <nav className="inline-flex rounded-md shadow-sm -space-x-px">
                <button
                  type="button"
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page <= 1}
                  className="inline-flex items-center justify-center px-3 py-2 rounded-l-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                {Array.from({ length: Math.min(5, pagination.totalPages) }, (_, i) => {
                  let pageNum = i + 1;
                  if (pagination.totalPages > 5) {
                    const start = Math.max(1, Math.min(page - 2, pagination.totalPages - 4));
                    pageNum = start + i;
                  }
                  return (
                    <button
                      key={pageNum}
                      type="button"
                      onClick={() => setPage(pageNum)}
                      className={`inline-flex items-center px-4 py-2 border text-sm font-medium ${
                        page === pageNum
                          ? 'z-10 bg-blue-50 border-oe-primary text-oe-primary'
                          : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
                      }`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setPage(Math.min(pagination.totalPages, page + 1))}
                  disabled={page >= pagination.totalPages}
                  className="inline-flex items-center justify-center px-3 py-2 rounded-r-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </nav>
            </div>
          )}

          <div className="space-y-3">
            {tenants.map((tenant) => {
              const isOpen = expanded.has(tenant.tenantId);
              return (
                <div key={tenant.tenantId} className="border border-gray-200 rounded-lg overflow-hidden bg-white">
                  <div className="flex items-stretch">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(tenant.tenantId)}
                      className="flex-1 flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 min-w-0"
                    >
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 text-gray-400 shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-gray-400 shrink-0" />
                      )}
                      <Building2 className="h-5 w-5 text-oe-primary shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-gray-900">{tenant.tenantName}</span>
                          {tenant.isExternal && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-100">
                              External
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {tenant.products.length} product{tenant.products.length !== 1 ? 's' : ''}
                          {' · '}
                          {totalHouseholds(tenant.products)} household{totalHouseholds(tenant.products) !== 1 ? 's' : ''}
                          {' · '}
                          {totalGroups(tenant.products)} group{totalGroups(tenant.products) !== 1 ? 's' : ''} enrolled
                        </p>
                      </div>
                    </button>
                    <button
                      type="button"
                      disabled={exportingTenantId === tenant.tenantId}
                      onClick={() => void downloadTenantExport(tenant.tenantId)}
                      className="shrink-0 inline-flex items-center gap-1.5 px-4 py-3 text-sm border-l border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      title="Download eligibility CSV for tenant audit"
                    >
                      {exportingTenantId === tenant.tenantId ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                      <span className="hidden sm:inline">Export CSV</span>
                    </button>
                  </div>

                  {isOpen && (
                    <div className="border-t border-gray-100 px-4 py-3 bg-gray-50/50">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-gray-500 uppercase tracking-wide">
                            <th className="pb-2 font-medium">Product</th>
                            <th className="pb-2 font-medium">Relationship</th>
                            <th className="pb-2 font-medium text-right">Households</th>
                            <th className="pb-2 font-medium text-right">Groups</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {tenant.products.map((product) => (
                            <tr key={product.productId} className="text-gray-800">
                              <td className="py-2 pr-4">{product.productName}</td>
                              <td className="py-2 pr-4 text-gray-500 text-xs">
                                {relationshipLabel(product.relationships)}
                              </td>
                              <td className="py-2 text-right tabular-nums">{product.stats.householdCount}</td>
                              <td className="py-2 text-right tabular-nums">{product.stats.groupCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {showPagination && (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600 pt-1">
              <p>
                Showing <span className="font-medium text-gray-900">{rangeStart}</span> to{' '}
                <span className="font-medium text-gray-900">{rangeEnd}</span> of{' '}
                <span className="font-medium text-gray-900">{pagination.total}</span> tenants
              </p>
              <nav className="inline-flex rounded-md shadow-sm -space-x-px">
                <button
                  type="button"
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page <= 1}
                  className="inline-flex items-center justify-center px-3 py-2 rounded-l-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                {Array.from({ length: Math.min(5, pagination.totalPages) }, (_, i) => {
                  let pageNum = i + 1;
                  if (pagination.totalPages > 5) {
                    const start = Math.max(1, Math.min(page - 2, pagination.totalPages - 4));
                    pageNum = start + i;
                  }
                  return (
                    <button
                      key={`bottom-${pageNum}`}
                      type="button"
                      onClick={() => setPage(pageNum)}
                      className={`inline-flex items-center px-4 py-2 border text-sm font-medium ${
                        page === pageNum
                          ? 'z-10 bg-blue-50 border-oe-primary text-oe-primary'
                          : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
                      }`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setPage(Math.min(pagination.totalPages, page + 1))}
                  disabled={page >= pagination.totalPages}
                  className="inline-flex items-center justify-center px-3 py-2 rounded-r-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </nav>
            </div>
          )}
        </>
      )}

      <VendorCreateTenantModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void load()}
      />
    </div>
  );
};

export default VendorImportTenantsPanel;
