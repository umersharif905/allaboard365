import { ArrowRight, Briefcase, ChevronDown, ChevronUp, Database, Link2, Package, Pencil, Plus, RotateCcw, Trash2, UserPlus, Users } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import MigrationInstanceModal from '../../../components/admin/migration/MigrationInstanceModal';
import E123CatalogUploadPanel from '../../../components/admin/migration/E123CatalogUploadPanel';
import { e123MigrationService, MigrationBatch, MigrationInstance } from '../../../services/e123Migration.service';
import {
  clearActiveMigrationBatch,
  isMemberImportBatchStatus,
  isResumableBatchStatus,
  listInProgressMemberImports,
  loadActiveMigrationBatch,
  loadActiveMigrationInstance,
  pickHighlightedMemberImportBatch,
  saveActiveMigrationBatch,
  saveActiveMigrationInstance
} from '../../../utils/e123MigrationSession';
import { e123MigrationPath, isE123MigrationPortalMode } from '../../../utils/e123MigrationPortal';

function formatBatchRootLabel(batch: MigrationBatch): string {
  return batch.displayRootAgentLabel
    || batch.RootAgentLabel
    || (batch.RootBrokerId != null ? `Broker ${batch.RootBrokerId}` : '—');
}

function formatBatchTenantLabel(batch: MigrationBatch): string {
  if (batch.TenantName) return batch.TenantName;
  if (['draft', 'fetching', 'ready'].includes(batch.Status)) return 'Not selected yet';
  return '—';
}

function formatBatchHouseholdCount(batch: MigrationBatch): string | number {
  if (batch.householdCount != null) return batch.householdCount;
  if (batch.FetchMembersLoaded != null) return batch.FetchMembersLoaded;
  if (batch.ApplyCreateCount != null) return batch.ApplyCreateCount;
  return '—';
}

function formatBatchBrokerMeta(batch: MigrationBatch): string | null {
  if (batch.RootBrokerId == null) return null;
  return `Broker ${batch.RootBrokerId}`;
}

const MEMBER_IMPORT_LIST_PAGE_SIZE = 5;

const MigrationHub: React.FC = () => {
  const navigate = useNavigate();
  const portalMode = isE123MigrationPortalMode();
  const [instances, setInstances] = useState<MigrationInstance[]>([]);
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
  const [activeInstanceLabel, setActiveInstanceLabel] = useState('');
  const [history, setHistory] = useState<MigrationBatch[]>([]);
  const [pending, setPending] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [configStatus, setConfigStatus] = useState<{
    memberSearchConfigured: boolean;
    adminV2Configured: boolean;
  } | null>(null);
  const [activeBatch, setActiveBatch] = useState<MigrationBatch | null>(null);
  const [newInstanceOpen, setNewInstanceOpen] = useState(false);
  const [editInstanceOpen, setEditInstanceOpen] = useState(false);
  const [portalEnabled, setPortalEnabled] = useState(!portalMode);
  const [discardingBatchId, setDiscardingBatchId] = useState<string | null>(null);
  const [showAllMemberImports, setShowAllMemberImports] = useState(false);

  const loadInstanceData = useCallback(async (instanceId: string | null) => {
    setLoading(true);
    try {
      const [histRes, pendingRes, cfgRes] = await Promise.all([
        e123MigrationService.listHistory(instanceId),
        e123MigrationService.listPending(instanceId),
        e123MigrationService.getConfigStatus(instanceId)
      ]);
      if (histRes.success) setHistory(histRes.data || []);
      if (pendingRes.success) setPending(pendingRes.data || []);
      if (cfgRes.success) setConfigStatus(cfgRes.data);

      const session = loadActiveMigrationBatch();
      const highlighted = histRes.success
        ? pickHighlightedMemberImportBatch(histRes.data || [], session?.batchId)
        : null;
      if (highlighted) {
        setActiveBatch(highlighted);
        saveActiveMigrationBatch(highlighted.BatchId);
      } else if (session?.batchId) {
        const batchRes = await e123MigrationService.getBatch(session.batchId);
        if (batchRes.success && batchRes.data && isResumableBatchStatus(batchRes.data.Status)) {
          setActiveBatch(batchRes.data);
        } else {
          clearActiveMigrationBatch();
          setActiveBatch(null);
        }
      } else {
        setActiveBatch(null);
      }
    } catch {
      // Migration API may not be deployed on this environment.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const boot = async () => {
      try {
        if (portalMode) {
          const statusRes = await e123MigrationService.getTenantPortalNavStatus();
          const status = statusRes.success ? statusRes.data : null;
          setPortalEnabled(!!status?.enabled);
          const instanceId = status?.instanceId || null;
          const label = status?.label || '';
          setActiveInstanceId(instanceId);
          setActiveInstanceLabel(label);
          if (instanceId) saveActiveMigrationInstance(instanceId, label);
          await loadInstanceData(instanceId);
          return;
        }

        const res = await e123MigrationService.listInstances();
        const rows = res.success ? (res.data || []) : [];
        setInstances(rows);

        const saved = loadActiveMigrationInstance();
        const initial = saved?.instanceId && rows.some((row) => row.instanceId === saved.instanceId)
          ? saved.instanceId
          : rows[0]?.instanceId || null;
        const label = rows.find((row) => row.instanceId === initial)?.label || saved?.label || '';
        setActiveInstanceId(initial);
        setActiveInstanceLabel(label);
        if (initial) saveActiveMigrationInstance(initial, label);
        await loadInstanceData(initial);
      } catch {
        await loadInstanceData(null);
      }
    };
    void boot();
  }, [loadInstanceData]);

  const handleInstanceChange = async (instanceId: string) => {
    const label = instances.find((row) => row.instanceId === instanceId)?.label || '';
    setActiveInstanceId(instanceId);
    setActiveInstanceLabel(label);
    saveActiveMigrationInstance(instanceId, label);
    await loadInstanceData(instanceId);
  };

  const handleInstanceSaved = async (instanceId: string, label: string) => {
    if (portalMode) {
      setActiveInstanceId(instanceId);
      setActiveInstanceLabel(label);
      saveActiveMigrationInstance(instanceId, label);
      await loadInstanceData(instanceId);
      return;
    }
    const res = await e123MigrationService.listInstances();
    const rows = res.success ? (res.data || []) : [];
    setInstances(rows);
    setActiveInstanceId(instanceId);
    setActiveInstanceLabel(label);
    saveActiveMigrationInstance(instanceId, label);
    await loadInstanceData(instanceId);
  };

  const instanceQuery = activeInstanceId ? `?instanceId=${encodeURIComponent(activeInstanceId)}` : '';

  const handleDiscardImport = async (batch: MigrationBatch) => {
    const label = formatBatchRootLabel(batch);
    const force = batch.Status === 'applying';
    const confirmed = window.confirm(
      force
        ? `"${label}" is still applying. Remove it anyway? This stops the apply job and hides the import from this list.`
        : `Remove "${label}" from in-progress imports? You can start a new import anytime; batch data stays in history as discarded.`
    );
    if (!confirmed) return;

    setDiscardingBatchId(batch.BatchId);
    try {
      const res = await e123MigrationService.discardBatch(batch.BatchId, { force });
      if (!res.success) {
        window.alert(res.message || 'Could not remove import');
        return;
      }
      if (activeBatch?.BatchId === batch.BatchId) {
        clearActiveMigrationBatch();
        setActiveBatch(null);
      }
      await loadInstanceData(activeInstanceId);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Could not remove import');
    } finally {
      setDiscardingBatchId(null);
    }
  };

  const inProgressMemberImports = useMemo(
    () => listInProgressMemberImports(history),
    [history]
  );

  const visibleMemberImports = useMemo(() => {
    if (showAllMemberImports) return inProgressMemberImports;
    return inProgressMemberImports.slice(0, MEMBER_IMPORT_LIST_PAGE_SIZE);
  }, [inProgressMemberImports, showAllMemberImports]);

  const hiddenMemberImportCount = Math.max(
    0,
    inProgressMemberImports.length - MEMBER_IMPORT_LIST_PAGE_SIZE
  );

  useEffect(() => {
    if (inProgressMemberImports.length <= MEMBER_IMPORT_LIST_PAGE_SIZE) {
      setShowAllMemberImports(false);
    }
  }, [inProgressMemberImports.length]);

  if (portalMode && !loading && !portalEnabled) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          E123 migration is not enabled for this tenant portal. Contact your administrator to enable it on your migration instance.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {!portalMode ? (
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 flex-1">
          <label className="text-sm font-medium text-gray-700 shrink-0">Migration</label>
          <select
            value={activeInstanceId || ''}
            onChange={(e) => void handleInstanceChange(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm min-w-[220px]"
            disabled={!instances.length}
          >
            {!instances.length ? (
              <option value="">No migrations yet</option>
            ) : instances.map((instance) => (
              <option key={instance.instanceId} value={instance.instanceId}>{instance.label}</option>
            ))}
          </select>
          {activeInstanceLabel ? (
            <span className="text-sm text-gray-500">{activeInstanceLabel}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {activeInstanceId ? (
            <button
              type="button"
              onClick={() => setEditInstanceOpen(true)}
              className="inline-flex items-center justify-center px-4 py-2 rounded-lg border border-gray-300 text-sm text-gray-800 hover:bg-gray-50"
            >
              <Pencil className="h-4 w-4 mr-2" />
              Edit migration
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setNewInstanceOpen(true)}
            className="inline-flex items-center justify-center px-4 py-2 rounded-lg border border-gray-300 text-sm text-gray-800 hover:bg-gray-50"
          >
            <Plus className="h-4 w-4 mr-2" />
            New migration
          </button>
        </div>
      </div>
      ) : activeInstanceLabel ? (
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-gray-900">E123 Migration</h1>
          <p className="mt-1 text-sm text-gray-600">{activeInstanceLabel}</p>
        </div>
      ) : null}

      {activeBatch && (
        <div className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-blue-900">In-progress member import</div>
            <div className="text-sm text-blue-800 mt-1 font-medium">
              {formatBatchRootLabel(activeBatch)}
            </div>
            <div className="text-xs text-blue-700/90 mt-0.5">
              {[formatBatchBrokerMeta(activeBatch), activeBatch.Status].filter(Boolean).join(' · ')}
            </div>
            {activeBatch.TenantName ? (
              <div className="text-xs text-blue-700/90 mt-0.5">
                Target tenant: {activeBatch.TenantName}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                clearActiveMigrationBatch();
                setActiveBatch(null);
              }}
              className="inline-flex items-center px-3 py-1.5 rounded-lg border border-blue-300 text-blue-800 text-sm hover:bg-blue-100"
            >
              <RotateCcw className="h-4 w-4 mr-1.5" />
              Dismiss
            </button>
            <Link
              to={e123MigrationPath(`/import/${activeBatch.BatchId}`)}
              className="inline-flex items-center px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700"
            >
              Resume <ArrowRight className="h-4 w-4 ml-1" />
            </Link>
          </div>
        </div>
      )}

      {!portalMode && !activeInstanceId ? (
        <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-4 text-sm">
          Create a migration instance with E123 login credentials before importing members.
        </div>
      ) : null}

      {configStatus && !configStatus.memberSearchConfigured && activeInstanceId ? (
        <div className="mb-6 bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-lg p-4 text-sm">
          E123 credentials are not configured for this migration instance. Edit the instance or add Corp ID, username, and password.
        </div>
      ) : null}

      {activeInstanceId ? (
        <E123CatalogUploadPanel instanceId={activeInstanceId} />
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8 items-start">
        <section className="bg-white rounded-lg border border-gray-200 p-6 flex flex-col">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-blue-50">
              <Users className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900">Member Migration</h2>
            </div>
          </div>
          <p className="text-sm text-gray-600 mb-4">
            Fetch active E123 members, select a tenant, map products, preview, and apply enrollments into AB365.
          </p>
          {inProgressMemberImports.length > 0 ? (
            <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-blue-900 mb-2">
                In-progress imports ({inProgressMemberImports.length})
              </div>
              <div className="space-y-2">
                {visibleMemberImports.map((batch) => (
                  <div
                    key={batch.BatchId}
                    className="flex items-start justify-between gap-3 rounded-md bg-white/80 px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate">{formatBatchRootLabel(batch)}</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {[formatBatchBrokerMeta(batch), batch.Status, `${formatBatchHouseholdCount(batch)} households`]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                      {batch.TenantName ? (
                        <div className="text-xs text-gray-500">{batch.TenantName}</div>
                      ) : null}
                    </div>
                    <div className="shrink-0 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void handleDiscardImport(batch)}
                        disabled={discardingBatchId === batch.BatchId}
                        className="inline-flex items-center text-gray-500 hover:text-red-600 disabled:opacity-50"
                        title="Remove from in-progress list"
                      >
                        <Trash2 className="h-4 w-4" />
                        <span className="sr-only">Remove</span>
                      </button>
                      <Link
                        to={e123MigrationPath(`/import/${batch.BatchId}`)}
                        className="inline-flex items-center text-blue-600 hover:text-blue-700 font-medium"
                      >
                        Resume <ArrowRight className="h-4 w-4 ml-1" />
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
              {hiddenMemberImportCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowAllMemberImports((v) => !v)}
                  className="mt-2 w-full inline-flex items-center justify-center gap-1 text-xs font-medium text-blue-800 hover:text-blue-900 py-1.5 rounded-md hover:bg-blue-100/80"
                >
                  {showAllMemberImports ? (
                    <>
                      <ChevronUp className="h-3.5 w-3.5" />
                      Show fewer
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3.5 w-3.5" />
                      View {hiddenMemberImportCount} more
                    </>
                  )}
                </button>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-gray-500 mb-4">No in-progress member imports for this migration instance.</p>
          )}
          <button
            type="button"
            onClick={() => navigate(`${e123MigrationPath('/import')}?fresh=1${activeInstanceId ? `&instanceId=${activeInstanceId}` : ''}`)}
            disabled={!activeInstanceId}
            className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 shrink-0"
          >
            <Plus className="h-4 w-4 mr-2" />
            New Member Import
          </button>
        </section>

        <section className="bg-white rounded-lg border border-gray-200 p-6 flex flex-col">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-violet-50">
              <Package className="h-6 w-6 text-violet-600" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900">Product Migration</h2>
            </div>
          </div>
          <p className="text-sm text-gray-600 mb-4">
            Map E123 products and pricing tiers to your catalog before importing members. Pairings are saved per tenant and reused across batches.
          </p>
          <Link
            to={`${e123MigrationPath('/products')}${instanceQuery}`}
            className={`inline-flex items-center justify-center px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 shrink-0 ${!activeInstanceId ? 'pointer-events-none opacity-50' : ''}`}
          >
            <Link2 className="h-4 w-4 mr-2" />
            Open Product Migration
          </Link>
        </section>

        <section className="bg-white rounded-lg border border-gray-200 p-6 flex flex-col">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-emerald-50">
              <UserPlus className="h-6 w-6 text-emerald-600" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900">Agent Migration</h2>
            </div>
          </div>
          <p className="text-sm text-gray-600 mb-4">
            Create AB365 agents from an E123 broker tree: email pairing, upline hierarchy, tiers, and ACH from E123 API.
          </p>
          <Link
            to={`${e123MigrationPath('/agents')}${instanceQuery}`}
            className={`inline-flex items-center justify-center px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 shrink-0 ${!activeInstanceId ? 'pointer-events-none opacity-50' : ''}`}
          >
            <UserPlus className="h-4 w-4 mr-2" />
            Open Agent Migration
          </Link>
        </section>

        <section className="bg-white rounded-lg border border-gray-200 p-6 flex flex-col">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-oe-light">
              <Briefcase className="h-6 w-6 text-oe-primary" />
            </div>
            <div>
              <h2 className="text-lg font-medium text-gray-900">Group Migration</h2>
            </div>
          </div>
          <p className="text-sm text-gray-600 mb-4">
            Create AB365 groups from the E123 groups list: detect, preview member conflicts, and apply in one wizard.
          </p>
          <Link
            to={`${e123MigrationPath('/groups')}${instanceQuery}`}
            className={`inline-flex items-center justify-center px-4 py-2 rounded-lg bg-oe-primary hover:bg-oe-dark text-white shrink-0 ${!activeInstanceId ? 'pointer-events-none opacity-50' : ''}`}
          >
            <Briefcase className="h-4 w-4 mr-2" />
            Open Group Migration
          </Link>
        </section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white rounded-lg border border-gray-200">
          <div className="p-6 border-b border-gray-200 flex items-center gap-2">
            <Database className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-medium text-gray-900">Pending Migration</h2>
          </div>
          <div className="p-6">
            {loading ? (
              <p className="text-gray-500 text-sm">Loading...</p>
            ) : !activeInstanceId ? (
              <p className="text-gray-500 text-sm">Select or create a migration instance.</p>
            ) : pending.length === 0 ? (
              <p className="text-gray-500 text-sm">No pending migration households yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead>
                    <tr>
                      <th className="text-left py-2 text-gray-500 font-medium">Member ID</th>
                      <th className="text-left py-2 text-gray-500 font-medium">Name</th>
                      <th className="text-left py-2 text-gray-500 font-medium">Tenant</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {(pending as Array<{ HouseholdMemberID?: string; FirstName?: string; LastName?: string; TenantName?: string }>).slice(0, 20).map((row, idx) => (
                      <tr key={idx}>
                        <td className="py-2 font-mono text-xs">{row.HouseholdMemberID}</td>
                        <td className="py-2">{row.FirstName} {row.LastName}</td>
                        <td className="py-2">{row.TenantName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <section className="bg-white rounded-lg border border-gray-200">
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900">Import History</h2>
          </div>
          <div className="p-6">
            {loading ? (
              <p className="text-gray-500 text-sm">Loading...</p>
            ) : !activeInstanceId ? (
              <p className="text-gray-500 text-sm">Select or create a migration instance.</p>
            ) : history.length === 0 ? (
              <p className="text-gray-500 text-sm">No import batches yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead>
                    <tr>
                      <th className="text-left py-2 text-gray-500 font-medium">E123 import root</th>
                      <th className="text-left py-2 text-gray-500 font-medium">Status</th>
                      <th className="text-left py-2 text-gray-500 font-medium">Households</th>
                      <th className="text-left py-2 text-gray-500 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {history.map((batch) => (
                      <tr key={batch.BatchId}>
                        <td className="py-2">
                          <div>{formatBatchRootLabel(batch)}</div>
                          {formatBatchBrokerMeta(batch) ? (
                            <div className="text-xs text-gray-400">{formatBatchBrokerMeta(batch)}</div>
                          ) : null}
                          <div className="text-xs text-gray-400">
                            Target tenant: {formatBatchTenantLabel(batch)}
                          </div>
                        </td>
                        <td className="py-2">
                          <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-800">
                            {batch.Status}
                          </span>
                        </td>
                        <td className="py-2">{formatBatchHouseholdCount(batch)}</td>
                        <td className="py-2 text-right">
                          <div className="inline-flex flex-col items-end gap-1">
                            {isMemberImportBatchStatus(batch.Status) ? (
                              <Link
                                to={e123MigrationPath(`/import/${batch.BatchId}`)}
                                className="inline-flex items-center text-blue-600 hover:text-blue-700"
                              >
                                {batch.Status === 'applied' ? 'View' : 'Resume'}
                                {' '}
                                <ArrowRight className="h-4 w-4 ml-1" />
                              </Link>
                            ) : null}
                            {batch.TenantId ? (
                              <Link
                                to={`${e123MigrationPath('/products')}?tenantId=${batch.TenantId}${activeInstanceId ? `&instanceId=${activeInstanceId}` : ''}`}
                                className="inline-flex items-center text-violet-600 hover:text-violet-700 text-xs"
                              >
                                Product maps
                                {' '}
                                <ArrowRight className="h-3.5 w-3.5 ml-0.5" />
                              </Link>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>

      {!portalMode ? (
        <>
          <MigrationInstanceModal
            isOpen={newInstanceOpen}
            onClose={() => setNewInstanceOpen(false)}
            onSaved={handleInstanceSaved}
            mode="create"
          />
          <MigrationInstanceModal
            isOpen={editInstanceOpen}
            onClose={() => setEditInstanceOpen(false)}
            onSaved={handleInstanceSaved}
            mode="edit"
            instanceId={activeInstanceId}
          />
        </>
      ) : null}
    </div>
  );
};

export default MigrationHub;
