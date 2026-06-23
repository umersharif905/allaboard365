import { ArrowLeft, Link2, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import SearchableDropdown from '../../../components/common/SearchableDropdown';
import E123CatalogUploadPanel from '../../../components/admin/migration/E123CatalogUploadPanel';
import MigrationProductMappingStep from '../../../components/admin/migration/MigrationProductMappingStep';
import {
  e123MigrationService,
  ProductMapSummary
} from '../../../services/e123Migration.service';
import {
  MigrationTenantOption,
  normalizeMigrationTenant
} from '../../../utils/migrationTenantOptions';
import { e123MigrationPath, isE123MigrationPortalMode } from '../../../utils/e123MigrationPortal';
import { loadActiveMigrationInstance } from '../../../utils/e123MigrationSession';

const E123ProductMigrationWizard: React.FC = () => {
  const navigate = useNavigate();
  const portalMode = isE123MigrationPortalMode();
  const [searchParams] = useSearchParams();
  const initialTenantId = searchParams.get('tenantId') || '';
  const instanceId = searchParams.get('instanceId') || loadActiveMigrationInstance()?.instanceId || '';

  const [tenants, setTenants] = useState<MigrationTenantOption[]>([]);
  const [resyncTarget, setResyncTarget] = useState<{ sourceProductKey: string; productId: string } | null>(null);
  const [tenantsLoading, setTenantsLoading] = useState(true);
  const [tenantsError, setTenantsError] = useState<string | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState(initialTenantId);
  const [mapSummary, setMapSummary] = useState<ProductMapSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const selectedTenantName = useMemo(
    () => tenants.find((t) => t.tenantId === selectedTenantId)?.name || '',
    [tenants, selectedTenantId]
  );

  const loadTenants = useCallback(async () => {
    setTenantsLoading(true);
    setTenantsError(null);
    try {
      const res = await e123MigrationService.listTenants(instanceId || undefined);
      if (!res.success) throw new Error(res.message || 'Failed to load tenants');
      const rows = (res.data || [])
        .map(normalizeMigrationTenant)
        .filter((row): row is MigrationTenantOption => !!row);
      setTenants(rows);
      if (portalMode && rows.length === 1) {
        setSelectedTenantId(rows[0].tenantId);
      }
    } catch (err: unknown) {
      setTenantsError(err instanceof Error ? err.message : 'Failed to load tenants');
    } finally {
      setTenantsLoading(false);
    }
  }, [portalMode, instanceId]);

  const loadMapSummary = useCallback(async (resolvedInstanceId: string) => {
    if (!resolvedInstanceId) {
      setMapSummary(null);
      return;
    }
    setSummaryLoading(true);
    try {
      const res = await e123MigrationService.getProductMapSummary(resolvedInstanceId);
      if (res.success && res.data) setMapSummary(res.data);
      else setMapSummary(null);
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTenants();
  }, [loadTenants]);

  useEffect(() => {
    if (instanceId) loadMapSummary(instanceId);
  }, [instanceId, loadMapSummary]);

  const handleMappingChange = useCallback(() => {
    if (instanceId) loadMapSummary(instanceId);
  }, [instanceId, loadMapSummary]);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <button
        type="button"
        onClick={() => navigate(e123MigrationPath())}
        className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900 mb-4"
      >
        <ArrowLeft className="h-4 w-4 mr-1" />
        Back to Migration Hub
      </button>

      <E123CatalogUploadPanel instanceId={instanceId || undefined} />

      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-1">Target Tenant</label>
        <p className="text-xs text-gray-500 mb-3">
          E123 products are discovered from households in any import batch for this tenant.
        </p>
        {tenantsError && (
          <div className="mb-2 text-xs text-red-600 flex items-center gap-2">
            <span>{tenantsError}</span>
            <button type="button" onClick={() => loadTenants()} className="text-blue-600 hover:text-blue-700 underline">
              Retry
            </button>
          </div>
        )}
        {portalMode && tenants.length === 1 ? (
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800">
            {tenants[0]?.name}
          </div>
        ) : (
        <SearchableDropdown
          options={tenants.map((t) => ({
            id: t.tenantId,
            value: t.tenantId,
            label: t.name
          }))}
          value={selectedTenantId}
          onChange={(val) => setSelectedTenantId(val)}
          placeholder="Select tenant..."
          loading={tenantsLoading}
        />
        )}
      </div>

      {selectedTenantId && mapSummary && !summaryLoading && (
        <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
          <div className="font-medium text-gray-900 mb-2">Saved pairings for {selectedTenantName}</div>
          <div className="flex flex-wrap gap-4 text-gray-700 mb-2">
            <span>{mapSummary.mappedProducts} mapped</span>
            <span>{mapSummary.partialProducts} partial</span>
            <span>{mapSummary.ignoredProducts} ignored</span>
            <span>{mapSummary.totalProducts} total E123 products</span>
          </div>
          {mapSummary.products.length > 0 && (
            <ul className="space-y-1 text-xs text-gray-600">
              {mapSummary.products.slice(0, 8).map((product) => (
                <li key={product.sourceProductKey} className="flex items-center gap-2">
                  <Link2 className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                  <span className="font-medium text-gray-800">{product.sourceProductLabel}</span>
                  {product.status === 'mapped' && product.ab365ProductName ? (
                    <>
                      <span className="text-green-700">→ {product.ab365ProductName}</span>
                      {product.ab365ProductId ? (
                        <button
                          type="button"
                          onClick={() => setResyncTarget({
                            sourceProductKey: product.sourceProductKey,
                            productId: product.ab365ProductId!
                          })}
                          className="inline-flex items-center gap-1 text-violet-700 hover:text-violet-900 font-medium"
                        >
                          <RefreshCw className="h-3 w-3" />
                          Resync
                        </button>
                      ) : null}
                    </>
                  ) : product.status === 'ignored' ? (
                    <span className="text-amber-700">ignored</span>
                  ) : product.status === 'partial' ? (
                    <span className="text-orange-700">partially mapped</span>
                  ) : (
                    <span className="text-gray-500">unmapped</span>
                  )}
                </li>
              ))}
              {mapSummary.products.length > 8 ? (
                <li className="text-gray-500">+ {mapSummary.products.length - 8} more</li>
              ) : null}
            </ul>
          )}
        </div>
      )}

      {selectedTenantId && instanceId ? (
        <MigrationProductMappingStep
          instanceId={instanceId}
          tenantId={selectedTenantId}
          tenantName={selectedTenantName}
          onMappingChange={handleMappingChange}
          resyncTarget={resyncTarget}
          onResyncTargetHandled={() => setResyncTarget(null)}
        />
      ) : selectedTenantId && !instanceId ? (
        <div className="text-sm text-amber-800 py-8 text-center border border-amber-200 bg-amber-50 rounded-lg">
          Open this page from a migration instance to save product mappings.
        </div>
      ) : (
        <div className="text-sm text-gray-500 py-8 text-center border border-dashed border-gray-200 rounded-lg">
          Select a tenant to begin pairing E123 products.
        </div>
      )}

      {selectedTenantId && (
        <p className="mt-6 text-sm text-gray-500">
          When mappings are complete, continue with{' '}
          <Link to={`${e123MigrationPath('/import')}?fresh=1`} className="text-blue-600 hover:text-blue-700">
            Member Migration
          </Link>
          .
        </p>
      )}
    </div>
  );
};

export default E123ProductMigrationWizard;
