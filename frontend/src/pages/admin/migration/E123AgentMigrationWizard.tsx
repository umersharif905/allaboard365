import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  Loader2,
  UserPlus
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import AgentTreePicker from '../../../components/admin/migration/AgentTreePicker';
import AgentAchReviewPanel from '../../../components/admin/migration/AgentAchReviewPanel';
import AgentMigrationTreePreview from '../../../components/admin/migration/AgentMigrationTreePreview';
import E123CatalogUploadPanel from '../../../components/admin/migration/E123CatalogUploadPanel';
import SearchableDropdown from '../../../components/common/SearchableDropdown';
import {
  AgentLookupResult,
  AgentMigrationAchPayload,
  AgentMigrationBatch,
  AgentMigrationDraftJson,
  AgentMigrationPreviewResult,
  AgentMigrationWorkspace,
  AgentMigrationWorkspaceProgress,
  AgentOption,
  e123MigrationService,
  waitForAgentMigrationWorkspace,
  workspacePhaseLabel
} from '../../../services/e123Migration.service';
import {
  MigrationTenantOption,
  normalizeMigrationTenant
} from '../../../utils/migrationTenantOptions';
import { loadTenantCommissionTierOptions } from '../../../utils/loadTenantCommissionTierOptions';
import { e123MigrationPath, isE123MigrationPortalMode } from '../../../utils/e123MigrationPortal';
import { loadActiveMigrationInstance } from '../../../utils/e123MigrationSession';

const STEPS = [
  'Broker, Tenant & Agency',
  'Tree & Matching',
  'ACH Review',
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
    <nav aria-label="Agent migration progress" className="mb-6">
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
                    ${isCompleted ? 'bg-emerald-600 text-white' : ''}
                    ${isCurrent ? 'border-2 border-emerald-600 text-emerald-700 bg-white' : ''}
                    ${!isCompleted && !isCurrent ? 'border-2 border-gray-200 text-gray-400 bg-white' : ''}
                    ${isClickable ? 'cursor-pointer hover:ring-2 hover:ring-emerald-500/30 focus:outline-none focus:ring-2 focus:ring-emerald-500/40' : ''}
                    ${!isReachable ? 'opacity-50 cursor-default' : ''}
                    disabled:cursor-default`}
                >
                  {isCompleted ? <CheckCircle className="h-4 w-4" /> : idx + 1}
                </button>
                <span
                  className={`mt-1 text-[11px] font-medium text-center max-w-[7rem] leading-tight ${
                    isCurrent
                      ? 'text-emerald-800'
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
                    idx < currentIndex ? 'bg-emerald-500' : 'bg-gray-200'
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

const E123AgentMigrationWizard: React.FC = () => {
  const navigate = useNavigate();
  const { batchId: routeBatchId } = useParams<{ batchId?: string }>();
  const [searchParams] = useSearchParams();
  const portalMode = isE123MigrationPortalMode();
  const instanceId = searchParams.get('instanceId') || loadActiveMigrationInstance()?.instanceId || '';

  const [step, setStep] = useState(0);
  const [furthestStepIndex, setFurthestStepIndex] = useState(0);
  const [batch, setBatch] = useState<AgentMigrationBatch | null>(null);
  const [loading, setLoading] = useState(!!routeBatchId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [brokerId, setBrokerId] = useState<number | null>(null);
  const [brokerLabel, setBrokerLabel] = useState('');
  const [includeDownline, setIncludeDownline] = useState(true);
  const [lookup, setLookup] = useState<AgentLookupResult | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  const [tenants, setTenants] = useState<MigrationTenantOption[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [agencies, setAgencies] = useState<Array<{ agencyId: string; name: string }>>([]);
  const [selectedAgencyId, setSelectedAgencyId] = useState('');
  const [agenciesLoading, setAgenciesLoading] = useState(false);

  const [workspace, setWorkspace] = useState<AgentMigrationWorkspace | null>(null);
  const [draftJson, setDraftJson] = useState<AgentMigrationDraftJson>({
    nodeOverrides: {},
    importSettings: {
      excludeAgentsWithNoMembers: true,
      excludeAgentsWithoutEmail: true
    }
  });
  const excludeAgentsWithNoMembers = draftJson.importSettings?.excludeAgentsWithNoMembers !== false;
  const excludeAgentsWithoutEmail = draftJson.importSettings?.excludeAgentsWithoutEmail !== false;
  const [achByBrokerId, setAchByBrokerId] = useState<Record<string, AgentMigrationAchPayload>>({});
  const [preview, setPreview] = useState<AgentMigrationPreviewResult | null>(null);
  const [applyDone, setApplyDone] = useState(false);
  const [workspaceBuildProgress, setWorkspaceBuildProgress] = useState<AgentMigrationWorkspaceProgress | null>(null);
  const [buildingWorkspace, setBuildingWorkspace] = useState(false);
  const [payablesConfigured, setPayablesConfigured] = useState(false);
  const [payablesStatusLoading, setPayablesStatusLoading] = useState(true);

  const selectedTenantName = useMemo(
    () => tenants.find((t) => t.tenantId === selectedTenantId)?.name || '',
    [tenants, selectedTenantId]
  );

  const tenantIdForTiers = selectedTenantId || batch?.tenantId || workspace?.batch?.tenantId || null;
  const [tierOptions, setTierOptions] = useState<
    Array<{ level: number; label: string; commissionLevelId: string }>
  >([]);
  const [tiersLoading, setTiersLoading] = useState(false);
  const [tierOptionsMeta, setTierOptionsMeta] = useState<{
    useCustomCommissionLevelsOnly?: boolean;
    effectiveLevelCount?: number;
  } | null>(null);
  const [tiersError, setTiersError] = useState<string | null>(null);
  const [tiersFromTenantApi, setTiersFromTenantApi] = useState(false);
  const [tiersLoadedForTenantId, setTiersLoadedForTenantId] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantIdForTiers) {
      setTierOptions([]);
      setTierOptionsMeta(null);
      setTiersError(null);
      setTiersFromTenantApi(false);
      return;
    }
    let cancelled = false;
    setTiersLoading(true);
    setTiersError(null);
    void loadTenantCommissionTierOptions(tenantIdForTiers)
      .then((result) => {
        if (cancelled) return;
        setTierOptions(result.options);
        setTierOptionsMeta(result.meta);
        setTiersError(result.error);
        setTiersFromTenantApi(result.loadedFromTenantApi);
        setTiersLoadedForTenantId(result.tenantId || tenantIdForTiers);
      })
      .finally(() => {
        if (!cancelled) setTiersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantIdForTiers]);

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
      const res = await e123MigrationService.getAgentMigrationBatch(id);
      if (!res.success || !res.data) throw new Error(res.message || 'Batch not found');
      const b = res.data;
      setBatch(b);
      setBrokerId(b.rootBrokerId);
      setBrokerLabel(b.rootAgentLabel || '');
      setIncludeDownline(b.includeDownline);
      if (b.tenantId) setSelectedTenantId(b.tenantId);
      if (b.agencyId) setSelectedAgencyId(b.agencyId);
      if (b.draftJson) {
        setDraftJson({
          nodeOverrides: b.draftJson.nodeOverrides || {},
          commissionRoster: b.draftJson.commissionRoster,
          importSettings: {
            excludeAgentsWithNoMembers: b.draftJson.importSettings?.excludeAgentsWithNoMembers !== false,
            excludeAgentsWithoutEmail: b.draftJson.importSettings?.excludeAgentsWithoutEmail !== false
          }
        });
      }
      const initialStep = b.wizardStep >= 2 ? Math.min(3, b.wizardStep - 1) : 0;
      setStep(initialStep);
      setFurthestStepIndex(b.status === 'applied' ? 3 : Math.max(initialStep, 0));
      if (b.status === 'applied') setApplyDone(true);

      if (b.status === 'building_workspace' && b.batchId) {
        setBuildingWorkspace(true);
        setBusy(true);
        try {
          const ws = await waitForAgentMigrationWorkspace(b.batchId, setWorkspaceBuildProgress);
          setWorkspace(ws);
          setStep(Math.max(1, b.wizardStep - 1));
        } catch (pollErr) {
          setError(pollErr instanceof Error ? pollErr.message : 'Workspace build failed');
        } finally {
          setBusy(false);
          setBuildingWorkspace(false);
        }
      } else if (b.batchId && b.wizardStep >= 2 && b.status !== 'applied') {
        try {
          const wsRes = await e123MigrationService.getAgentMigrationWorkspaceStatus(b.batchId);
          if (wsRes.success && wsRes.data?.status === 'ready' && wsRes.data.workspace) {
            setWorkspace(wsRes.data.workspace);
          }
        } catch {
          // workspace load is best-effort on refresh; user can rebuild from step 1
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load batch');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPayablesStatus = useCallback(async () => {
    if (!instanceId) {
      setPayablesConfigured(false);
      setPayablesStatusLoading(false);
      return;
    }
    setPayablesStatusLoading(true);
    try {
      const res = await e123MigrationService.getPayablesStatus(instanceId);
      setPayablesConfigured(Boolean(res.success && res.data?.configured && (res.data.agentCount ?? 0) > 0));
    } catch {
      setPayablesConfigured(false);
    } finally {
      setPayablesStatusLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    void loadTenants();
  }, [loadTenants]);

  useEffect(() => {
    void loadPayablesStatus();
  }, [loadPayablesStatus]);

  useEffect(() => {
    if (routeBatchId) void loadBatch(routeBatchId);
  }, [routeBatchId, loadBatch]);

  useEffect(() => {
    setFurthestStepIndex((prev) => Math.max(prev, step));
  }, [step]);

  const loadAgencies = useCallback(async (tenantId: string) => {
    if (!tenantId) {
      setAgencies([]);
      return;
    }
    setAgenciesLoading(true);
    try {
      const res = await e123MigrationService.listAgentMigrationAgencies(tenantId);
      if (res.success) setAgencies(res.data || []);
    } finally {
      setAgenciesLoading(false);
    }
  }, []);

  useEffect(() => {
    const tenantId = selectedTenantId || batch?.tenantId || '';
    if (tenantId) void loadAgencies(tenantId);
  }, [selectedTenantId, batch?.tenantId, loadAgencies]);

  const rebuildWorkspace = useCallback(async () => {
    if (!batch?.batchId) return;
    setBuildingWorkspace(true);
    setWorkspaceBuildProgress({ phase: 'starting', processed: 0, total: 0 });
    try {
      await e123MigrationService.startAgentMigrationWorkspaceBuild(batch.batchId, true);
      const ws = await waitForAgentMigrationWorkspace(batch.batchId, setWorkspaceBuildProgress);
      setWorkspace(ws);
      const batchRes = await e123MigrationService.getAgentMigrationBatch(batch.batchId);
      if (batchRes.success && batchRes.data?.draftJson) {
        setDraftJson((prev) => ({
          ...prev,
          commissionRoster: batchRes.data?.draftJson?.commissionRoster,
          nodeOverrides: batchRes.data?.draftJson?.nodeOverrides || prev.nodeOverrides || {}
        }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rebuild preview');
    } finally {
      setBuildingWorkspace(false);
    }
  }, [batch?.batchId]);

  const persistDraftAndRebuild = useCallback(async (nextDraft?: AgentMigrationDraftJson) => {
    const draft = nextDraft || draftJson;
    if (batch?.batchId) {
      setDraftJson(draft);
      await e123MigrationService.patchAgentMigrationBatch(batch.batchId, { draftJson: draft });
    }
    await rebuildWorkspace();
  }, [batch?.batchId, draftJson, rebuildWorkspace]);

  const handleAgentSelect = async (agent: AgentOption) => {
    setBrokerId(agent.rootBrokerId);
    setBrokerLabel(agent.rootAgentLabel || agent.label || '');
    setLookup(null);
    setLookupLoading(true);
    try {
      const res = await e123MigrationService.lookupAgent(agent.rootBrokerId, instanceId);
      if (res.success && res.data) setLookup(res.data);
    } finally {
      setLookupLoading(false);
    }
  };

  const handleStartBatch = async () => {
    if (!instanceId || !brokerId || !selectedTenantId || !selectedAgencyId) {
      setError('Select broker, tenant, and agency');
      return;
    }
    if (!payablesConfigured) {
      setError('Upload Payables Detail under E123 migration data on the Migration Hub (most recent full month).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let currentBatchId = batch?.batchId;
      if (!currentBatchId) {
        const createRes = await e123MigrationService.createAgentMigrationBatch({
          instanceId,
          rootBrokerId: brokerId,
          rootAgentLabel: brokerLabel || lookup?.agent?.label || null,
          includeDownline,
          tenantId: selectedTenantId,
          agencyId: selectedAgencyId,
          draftJson: {
            nodeOverrides: {},
            importSettings: {
              excludeAgentsWithNoMembers,
              excludeAgentsWithoutEmail
            }
          }
        });
        if (!createRes.success || !createRes.data) {
          throw new Error(createRes.message || 'Failed to create batch');
        }
        currentBatchId = createRes.data.batchId;
        setBatch(createRes.data);
        navigate(e123MigrationPath(`/agents/${currentBatchId}?instanceId=${instanceId}`), { replace: true });
      } else {
        await e123MigrationService.patchAgentMigrationBatch(currentBatchId, {
          tenantId: selectedTenantId,
          agencyId: selectedAgencyId,
          rootAgentLabel: brokerLabel,
          wizardStep: 2,
          draftJson: {
            ...draftJson,
            importSettings: {
              excludeAgentsWithNoMembers,
              excludeAgentsWithoutEmail
            }
          }
        });
      }

      setBuildingWorkspace(true);
      setWorkspaceBuildProgress({ phase: 'starting', processed: 0, total: 0 });
      const ws = await waitForAgentMigrationWorkspace(currentBatchId, setWorkspaceBuildProgress);
      setWorkspace(ws);
      setStep(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start');
    } finally {
      setBusy(false);
      setBuildingWorkspace(false);
    }
  };

  const goToStep = useCallback(
    async (targetStep: number) => {
      if (targetStep < 0 || targetStep >= STEPS.length || targetStep > furthestStepIndex) return;
      if (targetStep === step) return;
      if (targetStep >= 1 && !workspace) return;

      setError(null);
      setBusy(true);
      try {
        if (batch?.batchId) {
          await e123MigrationService.patchAgentMigrationBatch(batch.batchId, {
            draftJson,
            wizardStep: targetStep + 1
          });
        }
        if (targetStep === 3 && batch?.batchId && !preview && !applyDone) {
          const prev = await e123MigrationService.previewAgentMigration(batch.batchId);
          if (prev.success && prev.data) setPreview(prev.data);
        }
        setStep(targetStep);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to change step');
      } finally {
        setBusy(false);
      }
    },
    [batch?.batchId, draftJson, furthestStepIndex, step, workspace, preview, applyDone]
  );

  const goBack = () => {
    if (step <= 0) return;
    void goToStep(step - 1);
  };

  const saveDraftAndContinue = async (nextStep: number) => {
    if (!batch?.batchId) return;
    setBusy(true);
    setError(null);
    try {
      await e123MigrationService.patchAgentMigrationBatch(batch.batchId, {
        draftJson,
        wizardStep: nextStep + 1
      });
      if (nextStep === 3) {
        const prev = await e123MigrationService.previewAgentMigration(batch.batchId);
        if (prev.success && prev.data) setPreview(prev.data);
      }
      setStep(nextStep);
      setFurthestStepIndex((f) => Math.max(f, nextStep));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to continue');
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async () => {
    if (!batch?.batchId) return;
    setBusy(true);
    setError(null);
    try {
      await e123MigrationService.patchAgentMigrationBatch(batch.batchId, { draftJson });
      const filteredAch: Record<string, AgentMigrationAchPayload> = {};
      for (const [key, val] of Object.entries(achByBrokerId)) {
        const skip = draftJson.nodeOverrides?.[key]?.skipAch || val.skip;
        if (!skip && val.ach) filteredAch[key] = val;
      }
      const res = await e123MigrationService.applyAgentMigration(batch.batchId, filteredAch);
      if (!res.success) throw new Error(res.message || 'Apply failed');
      setApplyDone(true);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Apply failed');
    } finally {
      setBusy(false);
    }
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
        <div className="p-2 rounded-lg bg-emerald-50">
          <UserPlus className="h-6 w-6 text-emerald-600" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Agent Migration</h1>
          <p className="text-sm text-gray-600">Create AB365 agents from E123 broker tree + payables CSV</p>
        </div>
      </div>

      <WizardStepNav
        currentIndex={step}
        furthestIndex={furthestStepIndex}
        onStepClick={(idx) => void goToStep(idx)}
      />

      {error ? (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">{error}</div>
      ) : null}

      {buildingWorkspace ? (
        <div className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-900 mb-2">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            Building agent tree preview
          </div>
          <p className="text-sm text-emerald-800 mb-3">
            {workspacePhaseLabel(workspaceBuildProgress?.phase)}
            {workspaceBuildProgress?.total
              ? ` — ${workspaceBuildProgress.processed} / ${workspaceBuildProgress.total} brokers`
              : null}
          </p>
          {workspaceBuildProgress?.currentLabel ? (
            <p className="text-xs text-emerald-700/90 mb-3 truncate">
              Current: {workspaceBuildProgress.currentLabel}
              {workspaceBuildProgress.currentBrokerId
                ? ` (${workspaceBuildProgress.currentBrokerId})`
                : null}
            </p>
          ) : null}
          {workspaceBuildProgress?.total ? (
            <div className="h-2 rounded-full bg-emerald-100 overflow-hidden">
              <div
                className="h-full bg-emerald-600 transition-all duration-300"
                style={{
                  width: `${Math.min(
                    100,
                    Math.round((workspaceBuildProgress.processed / workspaceBuildProgress.total) * 100)
                  )}%`
                }}
              />
            </div>
          ) : (
            <div className="h-2 rounded-full bg-emerald-100 overflow-hidden">
              <div className="h-full w-1/3 bg-emerald-500 animate-pulse rounded-full" />
            </div>
          )}
          <p className="text-xs text-emerald-700/80 mt-3">
            Large downlines fetch E123 profiles in parallel (8 at a time). Server logs:
            {' '}
            <code className="text-[11px]">[agent-migration-workspace]</code>
          </p>
        </div>
      ) : null}

      {step === 0 && !buildingWorkspace && (
        <>
          <E123CatalogUploadPanel
            instanceId={instanceId}
            compact
            onImported={() => void loadPayablesStatus()}
          />
          <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">E123 import root</label>
              <AgentTreePicker
                instanceId={instanceId}
                selectedAgentId={brokerId}
                onSelect={(agent) => void handleAgentSelect(agent)}
              />
              {lookupLoading ? (
                <p className="text-xs text-gray-500 mt-2 flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> Verifying in E123…
                </p>
              ) : lookup?.agent ? (
                <p className="text-xs text-green-700 mt-2">Verified: {lookup.agent.label}</p>
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
            <label className="inline-flex items-start gap-2 text-sm text-gray-700 mt-3">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={excludeAgentsWithNoMembers}
                onChange={(e) => {
                  setDraftJson({
                    ...draftJson,
                    importSettings: {
                      ...draftJson.importSettings,
                      excludeAgentsWithNoMembers: e.target.checked
                    }
                  });
                }}
              />
              <span>
                Exclude agents with no active members
                <span className="block text-xs text-gray-500 mt-0.5">
                  Skips E123 brokers (and their empty subtrees) with no enrolled, non-cancelled members. Agency root is always kept.
                </span>
              </span>
            </label>
            <label className="inline-flex items-start gap-2 text-sm text-gray-700 mt-3">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={excludeAgentsWithoutEmail}
                onChange={(e) => {
                  setDraftJson({
                    ...draftJson,
                    importSettings: {
                      ...draftJson.importSettings,
                      excludeAgentsWithoutEmail: e.target.checked
                    }
                  });
                }}
              />
              <span>
                Exclude agents with no email
                <span className="block text-xs text-gray-500 mt-0.5">
                  Skips brokers E123 does not return an email for (cannot create AB365 users). Agency root is always kept.
                </span>
              </span>
            </label>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-1">Target tenant</label>
            <SearchableDropdown
              options={tenants.map((t) => ({ id: t.tenantId, value: t.tenantId, label: t.name }))}
              value={selectedTenantId}
              onChange={setSelectedTenantId}
              placeholder="Select tenant…"
              loading={tenantsLoading}
            />
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-1">Agency</label>
            <p className="text-xs text-gray-500 mb-2">Top-level imported agents attach under this agency when no upline is in scope.</p>
            <SearchableDropdown
              options={agencies.map((a) => ({ id: a.agencyId, value: a.agencyId, label: a.name }))}
              value={selectedAgencyId}
              onChange={setSelectedAgencyId}
              placeholder="Select agency…"
              loading={agenciesLoading}
              disabled={!selectedTenantId}
            />
          </div>

          {!payablesStatusLoading && !payablesConfigured ? (
            <div className="mb-6 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              Upload <strong>Payables Detail</strong> in the E123 migration data section above before continuing.
            </div>
          ) : null}

          <button
            type="button"
            disabled={
              busy
              || buildingWorkspace
              || payablesStatusLoading
              || !payablesConfigured
              || !brokerId
              || !selectedTenantId
              || !selectedAgencyId
            }
            onClick={() => void handleStartBatch()}
            className="inline-flex items-center px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Continue to tree preview
            <ArrowRight className="h-4 w-4 ml-2" />
          </button>
        </>
      )}

      {step === 1 && workspace && (
        <>
          <AgentMigrationTreePreview
            workspace={workspace}
            draftJson={draftJson}
            onDraftChange={setDraftJson}
            tierOptions={tierOptions}
            tiersLoading={tiersLoading}
            tierOptionsMeta={tierOptionsMeta}
            tiersError={tiersError}
            tiersFromTenantApi={tiersFromTenantApi}
            tiersLoadedForTenantId={tiersLoadedForTenantId}
            selectedTenantId={tenantIdForTiers}
            tenantName={selectedTenantName}
            batchId={batch?.batchId || null}
            instanceId={instanceId || null}
            defaultAgencyId={selectedAgencyId || batch?.agencyId || null}
            agencies={agencies}
            onRosterUploaded={() => void rebuildWorkspace()}
            onWorkspaceRebuild={(draft) => void persistDraftAndRebuild(draft)}
            onRefreshPreview={() => void rebuildWorkspace()}
          />
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={goBack}
              disabled={busy}
              className="inline-flex items-center px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </button>
            <button
              type="button"
              onClick={() => void saveDraftAndContinue(2)}
              disabled={busy || workspace.validation.hasCycle || workspace.validation.conflictCount > 0}
              className="inline-flex items-center px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Continue to ACH review
              <ArrowRight className="h-4 w-4 ml-2" />
            </button>
            {workspace.validation.conflictCount > 0 ? (
              <span className="text-sm text-red-600 self-center">Resolve conflicts before continuing</span>
            ) : null}
          </div>
        </>
      )}

      {step === 2 && workspace && (
        <>
          <AgentAchReviewPanel
            brokers={workspace.brokers}
            payables={workspace.payables}
            draftJson={draftJson}
            achByBrokerId={achByBrokerId}
            onAchChange={setAchByBrokerId}
            onDraftChange={setDraftJson}
          />
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={goBack}
              disabled={busy}
              className="inline-flex items-center px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </button>
            <button
              type="button"
              onClick={() => void saveDraftAndContinue(3)}
              disabled={busy}
              className="inline-flex items-center px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Preview & apply
              <ArrowRight className="h-4 w-4 ml-2" />
            </button>
          </div>
        </>
      )}

      {step === 3 && (
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="mb-4">
            <button
              type="button"
              onClick={goBack}
              disabled={busy || applyDone}
              className="inline-flex items-center px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </button>
          </div>
          {applyDone ? (
            <div className="flex items-start gap-3 text-green-800">
              <CheckCircle className="h-6 w-6 shrink-0" />
              <div>
                <div className="font-medium">Agent migration applied</div>
                <p className="text-sm mt-1 text-green-700">
                  New agents were created and broker maps saved for {selectedTenantName || 'the tenant'}.
                  Run Member Migration agent mapping to confirm pairings.
                </p>
              </div>
            </div>
          ) : preview ? (
            <>
              <div className="text-sm font-medium text-gray-900 mb-3">Apply preview</div>
              <ul className="text-sm text-gray-700 space-y-1 mb-4">
                <li>{preview.summary.createNew} new agent(s)</li>
                <li>{preview.summary.promoteUser} existing user(s) → agent role</li>
                <li>{preview.summary.mapExisting} existing agent(s) (map only)</li>
                {preview.summary.conflicts > 0 ? (
                  <li className="text-red-700">{preview.summary.conflicts} conflict(s)</li>
                ) : null}
              </ul>
              <button
                type="button"
                onClick={() => void handleApply()}
                disabled={busy || !preview.summary.canApply}
                className="inline-flex items-center px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Apply import
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={async () => {
                if (!batch?.batchId) return;
                setBusy(true);
                const res = await e123MigrationService.previewAgentMigration(batch.batchId);
                if (res.success && res.data) setPreview(res.data);
                setBusy(false);
              }}
              className="text-sm text-blue-600"
            >
              Load preview
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default E123AgentMigrationWizard;
