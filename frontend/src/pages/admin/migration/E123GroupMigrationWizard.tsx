import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  Loader2,
  Users
} from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import E123CatalogUploadPanel from '../../../components/admin/migration/E123CatalogUploadPanel';
import AgentTreePicker from '../../../components/admin/migration/AgentTreePicker';
import SearchableDropdown from '../../../components/common/SearchableDropdown';
import {
  e123MigrationService,
  GroupMigrationBatch,
  GroupMigrationDetectResult,
  GroupMigrationPreviewResult,
  GroupMigrationApplyResult,
  AgentOption,
} from '../../../services/e123Migration.service';
import {
  MigrationTenantOption,
  normalizeMigrationTenant
} from '../../../utils/migrationTenantOptions';
import { e123MigrationPath, isE123MigrationPortalMode } from '../../../utils/e123MigrationPortal';
import { loadActiveMigrationInstance } from '../../../utils/e123MigrationSession';

const STEPS = [
  'Instance & Tenant',
  'Detect Groups',
  'Member Preview',
  'Preview & Apply'
] as const;

function WizardStepNav({
  currentIndex,
  furthestIndex,
  onStepClick
}: {
  currentIndex: number;
  furthestIndex: number;
  onStepClick: (index: number) => void;
}) {
  return (
    <nav aria-label="Group migration progress" className="mb-6">
      <ol className="flex flex-wrap items-center gap-y-2">
        {STEPS.map((label, idx) => {
          const isCompleted = idx < currentIndex;
          const isCurrent = idx === currentIndex;
          const isReachable = idx <= furthestIndex;
          const isClickable = isReachable && !isCurrent;
          return (
            <li
              key={label}
              className={`flex items-center ${idx < STEPS.length - 1 ? 'flex-1 min-w-[4rem]' : ''}`}
            >
              <div className="flex flex-col items-center min-w-0">
                <button
                  type="button"
                  disabled={!isClickable}
                  onClick={() => isClickable && onStepClick(idx)}
                  title={isClickable ? `Go to ${label}` : undefined}
                  aria-current={isCurrent ? 'step' : undefined}
                  className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors shrink-0
                    ${isCompleted ? 'bg-oe-primary text-white' : ''}
                    ${isCurrent ? 'border-2 border-oe-primary text-oe-primary bg-white' : ''}
                    ${!isCompleted && !isCurrent ? 'border-2 border-gray-200 text-gray-400 bg-white' : ''}
                    ${isClickable ? 'cursor-pointer hover:ring-2 hover:ring-oe-primary/30 focus:outline-none focus:ring-2 focus:ring-oe-primary/40' : ''}
                    ${!isReachable ? 'opacity-50 cursor-default' : ''}
                    disabled:cursor-default`}
                >
                  {isCompleted ? <CheckCircle className="h-4 w-4" /> : idx + 1}
                </button>
                <span
                  className={`mt-1 text-[11px] font-medium text-center max-w-[7rem] leading-tight ${
                    isCurrent
                      ? 'text-oe-primary'
                      : isCompleted
                        ? 'text-gray-700'
                        : isReachable
                          ? 'text-gray-500'
                          : 'text-gray-400'
                  }`}
                >
                  {label}
                </span>
              </div>
              {idx < STEPS.length - 1 ? (
                <div
                  className={`hidden sm:block flex-1 h-0.5 mx-2 min-w-[1rem] ${
                    idx < currentIndex ? 'bg-oe-primary' : 'bg-gray-200'
                  }`}
                  aria-hidden
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ActionBadge({ action, excludeReason }: { action: string; excludeReason?: string | null }) {
  const styles: Record<string, string> = {
    create_new: 'bg-green-100 text-green-800',
    map_existing: 'bg-blue-100 text-blue-800',
    already_mapped: 'bg-gray-100 text-gray-600',
    conflict: 'bg-red-100 text-red-800',
    excluded: 'bg-yellow-100 text-yellow-800',
    create: 'bg-green-100 text-green-800',
    skip: 'bg-gray-100 text-gray-600',
    error: 'bg-red-100 text-red-800',
  };
  const labels: Record<string, string> = {
    create_new: 'Create',
    map_existing: 'Map',
    already_mapped: 'Already exists',
    conflict: 'Conflict',
    excluded: excludeReason === 'agent_unmapped' ? 'Needs agent' : 'Excluded',
    create: 'Create',
    skip: 'Skip',
    error: 'Error',
  };
  const cls = styles[action] ?? 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {labels[action] ?? action}
    </span>
  );
}

function PrereqChecklist({
  instanceId,
  onAllReady
}: {
  instanceId: string;
  onAllReady: (ready: boolean) => void;
}) {
  const [agentMapReady, setAgentMapReady] = useState<boolean | null>(null);
  const [groupsListReady, setGroupsListReady] = useState<boolean | null>(null);
  const [agentTreeReady, setAgentTreeReady] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!instanceId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    e123MigrationService.getGroupMigrationPrereqs(instanceId).then((prereqRes) => {
      if (cancelled) return;
      const prereqs = prereqRes.data;
      const groupsOk = Boolean(prereqs?.groupsListReady);
      const treeOk = Boolean(prereqs?.agentTreeReady);
      const mapOk = Boolean(prereqs?.agentMapReady);
      setGroupsListReady(groupsOk);
      setAgentTreeReady(treeOk);
      setAgentMapReady(mapOk);
      onAllReady(groupsOk && treeOk && mapOk);
    }).catch(() => {
      if (cancelled) return;
      setGroupsListReady(false);
      setAgentTreeReady(false);
      setAgentMapReady(false);
      onAllReady(false);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [instanceId, onAllReady]);

  const StatusIcon = ({ ready }: { ready: boolean | null }) => {
    if (ready === null || loading) return <Loader2 className="h-4 w-4 animate-spin text-gray-400" />;
    return ready
      ? <CheckCircle className="h-4 w-4 text-oe-success" />
      : <span className="h-4 w-4 rounded-full border-2 border-gray-300 inline-block" />;
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
      <h3 className="text-sm font-semibold text-gray-800 mb-3">Prerequisites</h3>
      <ul className="space-y-2 text-sm">
        <li className="flex items-center gap-2">
          <StatusIcon ready={agentMapReady} />
          <span className={agentMapReady ? 'text-gray-700' : 'text-gray-400'}>
            Agent map configured
          </span>
        </li>
        <li className="flex items-center gap-2">
          <StatusIcon ready={groupsListReady} />
          <span className={groupsListReady ? 'text-gray-700' : 'text-gray-400'}>
            Groups list uploaded (E123 Invoices → View Groups → Export List)
          </span>
        </li>
        <li className="flex items-center gap-2">
          <StatusIcon ready={agentTreeReady} />
          <span className={agentTreeReady ? 'text-gray-700' : 'text-gray-400'}>
            Agent tree snapshot uploaded
          </span>
        </li>
      </ul>
    </div>
  );
}

const E123GroupMigrationWizard: React.FC = () => {
  const navigate = useNavigate();
  const { batchId: routeBatchId } = useParams<{ batchId?: string }>();
  const [searchParams] = useSearchParams();
  const portalMode = isE123MigrationPortalMode();
  const instanceId = searchParams.get('instanceId') || loadActiveMigrationInstance()?.instanceId || '';

  const [step, setStep] = useState(0);
  const [furthestStepIndex, setFurthestStepIndex] = useState(0);
  const [batch, setBatch] = useState<GroupMigrationBatch | null>(null);
  const [loading, setLoading] = useState(!!routeBatchId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prereqsReady, setPrereqsReady] = useState(false);

  const [tenants, setTenants] = useState<MigrationTenantOption[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [brokerId, setBrokerId] = useState<number | null>(null);
  const [brokerLabel, setBrokerLabel] = useState('');
  const [includeDownline, setIncludeDownline] = useState(true);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupVerified, setLookupVerified] = useState<string | null>(null);

  const [detectResult, setDetectResult] = useState<GroupMigrationDetectResult | null>(null);
  const [previewResult, setPreviewResult] = useState<GroupMigrationPreviewResult | null>(null);
  const [applyResult, setApplyResult] = useState<GroupMigrationApplyResult | null>(null);
  const [applyDone, setApplyDone] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

  useEffect(() => {
    setFurthestStepIndex((prev) => Math.max(prev, step));
  }, [step]);

  const loadTenants = useCallback(async () => {
    setTenantsLoading(true);
    try {
      const res = await e123MigrationService.listTenants(instanceId || undefined);
      if (res.success) {
        const rows = (res.data || [])
          .map(normalizeMigrationTenant)
          .filter((row): row is MigrationTenantOption => !!row);
        setTenants(rows);
        if (portalMode && rows.length === 1) setSelectedTenantId(rows[0].tenantId);
      }
    } finally {
      setTenantsLoading(false);
    }
  }, [instanceId, portalMode]);

  const loadBatch = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await e123MigrationService.getGroupMigrationBatch(id);
      if (!res.success || !res.data) throw new Error(res.message || 'Batch not found');
      const b = res.data;
      setBatch(b);
      if (b.tenantId) setSelectedTenantId(b.tenantId);
      if (b.rootBrokerId) setBrokerId(b.rootBrokerId);
      if (b.rootAgentLabel) setBrokerLabel(b.rootAgentLabel);
      if (b.includeDownline != null) setIncludeDownline(!!b.includeDownline);
      const initialStep = Math.min(3, Math.max(0, b.wizardStep - 1));
      setStep(initialStep);
      setFurthestStepIndex(b.status === 'applied' ? 3 : Math.max(initialStep, 0));
      if (b.status === 'applied') setApplyDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load batch');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTenants();
  }, [loadTenants]);

  useEffect(() => {
    if (routeBatchId) void loadBatch(routeBatchId);
  }, [routeBatchId, loadBatch]);

  const goToStep = useCallback(
    (targetStep: number) => {
      if (targetStep < 0 || targetStep >= STEPS.length || targetStep > furthestStepIndex) return;
      setStep(targetStep);
    },
    [furthestStepIndex]
  );

  const goBack = () => {
    if (step <= 0) return;
    goToStep(step - 1);
  };

  const handleAgentSelect = async (agent: AgentOption) => {
    setBrokerId(agent.rootBrokerId);
    setBrokerLabel(agent.rootAgentLabel || agent.label || '');
    setLookupVerified(null);
    setLookupLoading(true);
    try {
      const res = await e123MigrationService.lookupAgent(agent.rootBrokerId, instanceId);
      if (res.success && res.data?.agent?.label) {
        setLookupVerified(res.data.agent.label);
      }
    } finally {
      setLookupLoading(false);
    }
  };

  /** Step 0 → 1: create batch and advance */
  const handleCreateBatch = async () => {
    if (!instanceId || !selectedTenantId || !brokerId) {
      setError('Select an E123 import root, target tenant, and complete prerequisites before continuing.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let currentBatchId = batch?.batchId;
      if (!currentBatchId) {
        const createRes = await e123MigrationService.createGroupMigrationBatch({
          instanceId,
          tenantId: selectedTenantId,
          rootBrokerId: brokerId,
          rootAgentLabel: brokerLabel || lookupVerified || null,
          includeDownline,
        });
        if (!createRes.success || !createRes.data) {
          throw new Error(createRes.message || 'Failed to create batch');
        }
        setBatch(createRes.data);
        currentBatchId = createRes.data.batchId;
        navigate(e123MigrationPath(`/groups/${currentBatchId}?instanceId=${instanceId}`), { replace: true });
      } else {
        await e123MigrationService.patchGroupMigrationBatch(currentBatchId, {
          tenantId: selectedTenantId,
          rootBrokerId: brokerId,
          rootAgentLabel: brokerLabel || lookupVerified || null,
          includeDownline,
          wizardStep: 2,
        });
      }
      setStep(1);
      setFurthestStepIndex((f) => Math.max(f, 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to proceed');
    } finally {
      setBusy(false);
    }
  };

  /** Step 1 → 2: run detect */
  const handleDetect = async () => {
    if (!batch?.batchId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await e123MigrationService.detectGroupMigration(batch.batchId);
      if (!res.success || !res.data) throw new Error(res.message || 'Detect failed');
      setDetectResult(res.data);
      await e123MigrationService.patchGroupMigrationBatch(batch.batchId, { wizardStep: 2 });
      // Don't auto-advance — show results in step 1, user clicks continue
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Detect failed');
    } finally {
      setBusy(false);
    }
  };

  /** Step 1 → 2: advance after reviewing detect results */
  const handleAdvanceToPreview = async () => {
    if (!batch?.batchId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await e123MigrationService.previewGroupMigration(batch.batchId);
      if (!res.success || !res.data) throw new Error(res.message || 'Preview failed');
      setPreviewResult(res.data);
      await e123MigrationService.patchGroupMigrationBatch(batch.batchId, { wizardStep: 3 });
      setStep(2);
      setFurthestStepIndex((f) => Math.max(f, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setBusy(false);
    }
  };

  const buildApplyGroups = () => {
    if (!detectResult?.groups?.length) return [];
    return detectResult.groups
      .filter((g) => g.isEmployerGroup !== false && g.action === 'create_new')
      .map((g) => ({
        e123BrokerId: g.e123BrokerId,
        label: g.label,
        contactName: g.contactName,
        contactEmail: g.email ?? g.contactEmail ?? null,
        contactPhone: g.contactPhone ?? null,
        taxId: g.taxId ?? null,
        address: g.address ?? null,
        address2: g.address2 ?? null,
        city: g.city ?? null,
        state: g.state ?? null,
        zip: g.zip ?? null,
      }));
  };

  /** Step 3: apply */
  const handleApply = async () => {
    if (!batch?.batchId) return;
    const groups = buildApplyGroups();
    if (!groups.length) {
      setError('No groups are ready to apply. Run detect and resolve agent mapping first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await e123MigrationService.applyGroupMigration(batch.batchId, groups);
      if (!res.success || !res.data) throw new Error(res.message || 'Apply failed');
      setApplyResult(res.data);
      setApplyDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Apply failed');
    } finally {
      setBusy(false);
    }
  };

  /** Step 2 → 3: run preview (re-run or navigate) */
  const handlePreview = async () => {
    if (!batch?.batchId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await e123MigrationService.previewGroupMigration(batch.batchId);
      if (!res.success || !res.data) throw new Error(res.message || 'Preview failed');
      setPreviewResult(res.data);
      await e123MigrationService.patchGroupMigrationBatch(batch.batchId, { wizardStep: 4 });
      setStep(3);
      setFurthestStepIndex((f) => Math.max(f, 3));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setBusy(false);
    }
  };

  const toggleExpandRow = (brokerId: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(brokerId)) next.delete(brokerId);
      else next.add(brokerId);
      return next;
    });
  };

  if (!instanceId && !loading) {
    return (
      <div className="p-6 max-w-3xl mx-auto text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg">
        Select a migration instance from the Migration Hub first.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-gray-600">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading…
      </div>
    );
  }

  return (
    <div className="w-full max-w-none px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
      <button
        type="button"
        onClick={() => navigate(e123MigrationPath())}
        className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900 mb-4"
      >
        <ArrowLeft className="h-4 w-4 mr-1" />
        Back to Migration Hub
      </button>

      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-oe-light">
          <Users className="h-6 w-6 text-oe-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Group Migration</h1>
          <p className="text-sm text-gray-600">
            Import E123 employer groups into AB365 — create new ones or confirm ones already synced.
          </p>
        </div>
      </div>

      <WizardStepNav
        currentIndex={step}
        furthestIndex={furthestStepIndex}
        onStepClick={goToStep}
      />

      {error ? (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">{error}</div>
      ) : null}

      {/* ── Step 0: Instance & Tenant ── */}
      {step === 0 && (
        <>
          {instanceId ? (
            <E123CatalogUploadPanel
              instanceId={instanceId}
              compact
              onImported={() => {/* refresh prereqs via key change if needed */}}
            />
          ) : null}

          <PrereqChecklist
            instanceId={instanceId}
            onAllReady={setPrereqsReady}
          />

          <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">E123 import root</label>
              <p className="text-xs text-gray-500 mb-2">
                Only employer groups under this broker&apos;s downline are imported into the selected tenant.
                Run a separate batch per downline when groups map to different tenants.
              </p>
              <AgentTreePicker
                instanceId={instanceId}
                selectedAgentId={brokerId}
                onSelect={(agent) => void handleAgentSelect(agent)}
              />
              {lookupLoading ? (
                <p className="text-xs text-gray-500 mt-2 flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> Verifying in E123…
                </p>
              ) : lookupVerified ? (
                <p className="text-xs text-green-700 mt-2">Verified: {lookupVerified}</p>
              ) : null}
            </div>
            <label className="inline-flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={includeDownline}
                onChange={(e) => setIncludeDownline(e.target.checked)}
              />
              Include full downline under selected broker
            </label>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Target tenant
              <span className="ml-1 text-gray-400 text-xs">(groups will be created here)</span>
            </label>
            <SearchableDropdown
              options={tenants.map((t) => ({ id: t.tenantId, value: t.tenantId, label: t.name }))}
              value={selectedTenantId}
              onChange={setSelectedTenantId}
              placeholder="Select tenant…"
              loading={tenantsLoading}
            />
          </div>

          {!prereqsReady ? (
            <div className="mb-6 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              Upload the required data files above before continuing. The groups list CSV is required.
            </div>
          ) : null}

          <button
            type="button"
            disabled={busy || !selectedTenantId || !brokerId || !prereqsReady}
            onClick={() => void handleCreateBatch()}
            className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary hover:bg-oe-dark text-white disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Continue to group detection
            <ArrowRight className="h-4 w-4 ml-2" />
          </button>
        </>
      )}

      {/* ── Step 1: Detect Groups ── */}
      {step === 1 && (
        <>
          <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
            <p className="text-sm text-gray-600 mb-4">
              Employer list-bill groups under{' '}
              <span className="font-medium text-gray-900">
                {batch?.rootAgentLabel || (batch?.rootBrokerId ? `Broker ${batch.rootBrokerId}` : 'selected broker')}
              </span>
              {batch?.includeDownline === false ? ' (direct only)' : ' (full downline)'}.
              Copy Over buckets, org placeholders, and zero-member nodes are filtered out.
            </p>
            {detectResult ? (
              <>
                {(() => {
                  const employerGroups = detectResult.groups.filter((g) => g.isEmployerGroup !== false);
                  const hiddenNonEmployer = detectResult.groups.length - employerGroups.length;
                  const outsideDownline = detectResult.summary.outsideDownlineCount ?? 0;
                  return (
                    <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
                  {[
                    { label: 'Employer Groups', value: employerGroups.length, cls: 'text-gray-900' },
                    { label: 'Create New', value: detectResult.summary.createNew, cls: 'text-oe-success' },
                    { label: 'Already Exists', value: detectResult.summary.alreadyMapped, cls: 'text-gray-500' },
                    { label: 'Needs Agent', value: detectResult.summary.excludedAgentUnmapped ?? 0, cls: (detectResult.summary.excludedAgentUnmapped ?? 0) > 0 ? 'text-amber-600' : 'text-gray-500' },
                  ].map(({ label, value, cls }) => (
                    <div key={label} className="rounded-lg bg-gray-50 p-3 text-center">
                      <div className={`text-xl font-semibold ${cls}`}>{value}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
                    </div>
                  ))}
                </div>
                {hiddenNonEmployer > 0 ? (
                  <p className="text-xs text-gray-500 mb-1">
                    {hiddenNonEmployer} non-employer row{hiddenNonEmployer === 1 ? '' : 's'} hidden (Copy Over buckets, org placeholders, zero members).
                  </p>
                ) : null}
                {outsideDownline > 0 ? (
                  <p className="text-xs text-gray-500 mb-3">
                    {outsideDownline} group{outsideDownline === 1 ? '' : 's'} outside this broker downline hidden.
                  </p>
                ) : null}
                {!hiddenNonEmployer && !outsideDownline ? <div className="mb-3" /> : null}
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead>
                      <tr>
                        <th className="text-left py-2 px-3 text-gray-500 font-medium">Group</th>
                        <th className="text-left py-2 px-3 text-gray-500 font-medium">Members</th>
                        <th className="text-left py-2 px-3 text-gray-500 font-medium">Action</th>
                        <th className="text-left py-2 px-3 text-gray-500 font-medium">Agent</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {employerGroups.map((grp) => (
                        <tr key={grp.e123BrokerId} className="hover:bg-gray-50">
                          <td className="py-2 px-3">
                            <div className="font-medium text-gray-900">{grp.label}</div>
                            {grp.email ? (
                              <div className="text-xs text-gray-500">{grp.email}</div>
                            ) : null}
                            {grp.excludeReason === 'agent_unmapped' ? (
                              <div className="text-xs text-amber-700 mt-0.5">Agent not mapped — run Agent Migration first</div>
                            ) : null}
                            {grp.conflictReason ? (
                              <div className="text-xs text-red-600 mt-0.5">{grp.conflictReason}</div>
                            ) : null}
                          </td>
                          <td className="py-2 px-3 text-gray-700">{grp.memberCount}</td>
                          <td className="py-2 px-3">
                            <ActionBadge action={grp.action} excludeReason={grp.excludeReason} />
                          </td>
                          <td className="py-2 px-3">
                            {grp.agentMapped ? (
                              <span className="text-xs text-oe-success font-medium">{grp.agentName || 'Mapped'}</span>
                            ) : (
                              <span className="text-xs text-amber-600">Not mapped</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                    </>
                  );
                })()}
              </>
            ) : (
              <p className="text-sm text-gray-500">
                Click &quot;Detect Groups&quot; to read the staged E123 View Groups export and compare it to
                groups already imported into AB365. Results show what to create, what already exists, and
                which groups still need their selling agent mapped.
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={goBack}
              disabled={busy}
              className="inline-flex items-center px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </button>
            {!detectResult ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleDetect()}
                className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary hover:bg-oe-dark text-white disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Detect Groups
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || (detectResult.summary.conflicts > 0 && detectResult.summary.createNew === 0 && detectResult.summary.mapExisting === 0)}
                onClick={() => void handleAdvanceToPreview()}
                className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary hover:bg-oe-dark text-white disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Continue to member preview
                <ArrowRight className="h-4 w-4 ml-2" />
              </button>
            )}
          </div>
        </>
      )}

      {/* ── Step 2: Member Preview ── */}
      {step === 2 && (
        <>
          <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
            <p className="text-sm text-gray-600 mb-4">
              Preview shows which groups will be created or mapped, plus any member conflicts that must be resolved.
            </p>
            {previewResult ? (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
                  {[
                    { label: 'Create', value: previewResult.summary.createCount, cls: 'text-oe-success' },
                    { label: 'Map', value: previewResult.summary.mapCount, cls: 'text-blue-600' },
                    { label: 'Skip', value: previewResult.summary.skipCount, cls: 'text-gray-500' },
                    { label: 'Conflicts', value: previewResult.summary.conflictCount, cls: previewResult.summary.conflictCount > 0 ? 'text-red-600' : 'text-gray-500' },
                  ].map(({ label, value, cls }) => (
                    <div key={label} className="rounded-lg bg-gray-50 p-3 text-center">
                      <div className={`text-xl font-semibold ${cls}`}>{value}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
                    </div>
                  ))}
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead>
                      <tr>
                        <th className="text-left py-2 px-3 text-gray-500 font-medium">Group</th>
                        <th className="text-left py-2 px-3 text-gray-500 font-medium">Members</th>
                        <th className="text-left py-2 px-3 text-gray-500 font-medium">Action</th>
                        <th className="text-left py-2 px-3 text-gray-500 font-medium">Note</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {previewResult.rows.map((row) => (
                        <React.Fragment key={row.e123BrokerId}>
                          <tr
                            className={`${row.conflictCount > 0 ? 'bg-red-50/40' : 'hover:bg-gray-50'} cursor-pointer`}
                            onClick={() => row.conflictCount > 0 && toggleExpandRow(row.e123BrokerId)}
                          >
                            <td className="py-2 px-3">
                              <div className="font-medium text-gray-900">{row.label}</div>
                            </td>
                            <td className="py-2 px-3 text-gray-700">{row.memberCount}</td>
                            <td className="py-2 px-3">
                              <ActionBadge action={row.action} excludeReason={row.action === 'excluded' ? 'agent_unmapped' : undefined} />
                            </td>
                            <td className="py-2 px-3">
                              <span className={row.conflictCount > 0 ? 'text-red-600 text-xs' : 'text-gray-500 text-xs'}>
                                {row.conflictCount > 0 ? `${row.conflictCount} conflict(s)` : row.message}
                              </span>
                            </td>
                          </tr>
                          {expandedRows.has(row.e123BrokerId) && row.conflictDetails && row.conflictDetails.length > 0 ? (
                            <tr>
                              <td colSpan={4} className="bg-red-50 px-6 py-3">
                                <div className="text-xs font-medium text-red-800 mb-1">Member conflicts:</div>
                                <ul className="space-y-0.5 text-xs text-red-700">
                                  {row.conflictDetails.map((cd) => (
                                    <li key={cd.memberId}>
                                      <span className="font-mono">{cd.memberId}</span> — {cd.memberName}: {cd.reason}
                                    </li>
                                  ))}
                                </ul>
                              </td>
                            </tr>
                          ) : null}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="text-sm text-gray-500">Loading preview…</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={goBack}
              disabled={busy}
              className="inline-flex items-center px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </button>
            {previewResult ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => { setStep(3); setFurthestStepIndex((f) => Math.max(f, 3)); }}
                className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary hover:bg-oe-dark text-white disabled:opacity-50"
              >
                Continue to apply
                <ArrowRight className="h-4 w-4 ml-2" />
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handlePreview()}
                className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary hover:bg-oe-dark text-white disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Load preview
              </button>
            )}
          </div>
        </>
      )}

      {/* ── Step 3: Preview & Apply ── */}
      {step === 3 && (
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          {!applyDone && (
            <div className="mb-4">
              <button
                type="button"
                onClick={goBack}
                disabled={busy}
                className="inline-flex items-center px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </button>
            </div>
          )}

          {applyDone && applyResult ? (
            <div className="flex items-start gap-3 text-oe-success mb-6">
              <CheckCircle className="h-6 w-6 shrink-0" />
              <div>
                <div className="font-medium text-gray-900">Group migration applied</div>
                <p className="text-sm mt-1 text-gray-600">
                  {applyResult.summary.created} group(s) created, {applyResult.summary.mapped} mapped,{' '}
                  {applyResult.summary.skipped} skipped
                  {applyResult.summary.errors > 0 ? `, ${applyResult.summary.errors} error(s)` : ''}.
                </p>
              </div>
            </div>
          ) : previewResult ? (
            <>
              <div className="text-sm font-medium text-gray-900 mb-3">Summary before applying</div>
              <ul className="text-sm text-gray-700 space-y-1 mb-4">
                <li>{previewResult.summary.createCount} group(s) will be created</li>
                <li>{previewResult.summary.mapCount} group(s) will be mapped</li>
                <li>{previewResult.summary.skipCount} group(s) will be skipped</li>
                {previewResult.summary.conflictCount > 0 ? (
                  <li className="text-red-700">{previewResult.summary.conflictCount} conflict(s) detected — these groups will be skipped</li>
                ) : null}
              </ul>
              <button
                type="button"
                disabled={busy || !previewResult.canApply}
                onClick={() => void handleApply()}
                className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary hover:bg-oe-dark text-white disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Apply import
              </button>
              {!previewResult.canApply ? (
                <p className="text-xs text-red-600 mt-2">Resolve blocking issues before applying.</p>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handlePreview()}
              className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary hover:bg-oe-dark text-white disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Load preview
            </button>
          )}

          {/* Results table after apply */}
          {applyDone && applyResult && applyResult.results.length > 0 ? (
            <div className="mt-6 overflow-x-auto">
              <div className="text-sm font-medium text-gray-800 mb-2">Results</div>
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead>
                  <tr>
                    <th className="text-left py-2 px-3 text-gray-500 font-medium">Group</th>
                    <th className="text-left py-2 px-3 text-gray-500 font-medium">Action</th>
                    <th className="text-left py-2 px-3 text-gray-500 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {applyResult.results.map((r) => (
                    <tr key={r.e123BrokerId}>
                      <td className="py-2 px-3 font-medium text-gray-900">{r.label}</td>
                      <td className="py-2 px-3">
                        <ActionBadge action={r.action} />
                      </td>
                      <td className="py-2 px-3 text-gray-600 text-xs">{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};

export default E123GroupMigrationWizard;
