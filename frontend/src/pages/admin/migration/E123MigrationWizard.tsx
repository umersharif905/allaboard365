import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  Loader2
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import SearchableDropdown from '../../../components/common/SearchableDropdown';
import AgentTreePicker from '../../../components/admin/migration/AgentTreePicker';
import E123CatalogUploadPanel from '../../../components/admin/migration/E123CatalogUploadPanel';
import MigrationProductMappingStep from '../../../components/admin/migration/MigrationProductMappingStep';
import MigrationAgentMappingStep from '../../../components/admin/migration/MigrationAgentMappingStep';
import {
  AgentLookupResult,
  AgentOption,
  BatchSelectionSummary,
  clearAgentMappingWorkspaceCacheForBatch,
  e123MigrationService,
  HouseholdSummaryRow,
  MigrationBatch,
  MigrationApplyResult,
  PreviewRow,
  parseBatchImportSettings,
  parseBatchFetchProgress,
  readAgentMappingWorkspaceCache
} from '../../../services/e123Migration.service';
import {
  clearActiveMigrationBatch,
  clearProductMappingDraft,
  isResumableBatchStatus,
  loadActiveMigrationBatch,
  loadActiveMigrationInstance,
  saveActiveMigrationBatch
} from '../../../utils/e123MigrationSession';
import {
  MigrationTenantOption,
  normalizeMigrationTenant
} from '../../../utils/migrationTenantOptions';
import { e123MigrationPath, isE123MigrationPortalMode } from '../../../utils/e123MigrationPortal';

const STEPS = ['Select Members', 'Select Tenant', 'Agent Mapping', 'Product Mapping', 'Preview & Apply'] as const;
const PREVIEW_PAGE_SIZE = 50;
const PREVIEW_FIRST_CHUNK_SIZE = 1;
const PREVIEW_CHUNK_SIZE = 8;

function formatPremiumOffsetAdjustment(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  if (rounded > 0) return `+$${rounded.toFixed(2)}`;
  if (rounded < 0) return `-$${Math.abs(rounded).toFixed(2)}`;
  return '$0.00';
}

function normalizeMigrationBatchStatus(status: string | undefined | null): string {
  return String(status ?? '').trim().toLowerCase();
}

function wizardStepWasInitialized(batchId: string): boolean {
  try {
    return sessionStorage.getItem(`e123-wizard-step-init:${batchId}`) === '1';
  } catch {
    return false;
  }
}

function markWizardStepInitialized(batchId: string) {
  try {
    sessionStorage.setItem(`e123-wizard-step-init:${batchId}`, '1');
  } catch {
    /* ignore quota / private mode */
  }
}

function migrationErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

type AgentCatalogDiagnostics = {
  memberSearchConfigured?: boolean;
  orgBrokerConfigured?: boolean;
  orgBrokerDiscovering?: boolean;
  resolvedOrgBrokerId?: number | null;
  issues?: string[];
  notes?: string[];
};

function isOrgBrokerDiagnosticMessage(message: string): boolean {
  return /org broker id is not set|org broker auto-discovery/i.test(message);
}

function formatAgentCatalogLoadError(diagnostics?: AgentCatalogDiagnostics | null): string | null {
  const issues = (diagnostics?.issues || []).filter((issue) => !isOrgBrokerDiagnosticMessage(issue));
  if (issues.length) return issues.join(' ');
  if (diagnostics?.memberSearchConfigured === false) {
    return 'E123 credentials are missing on this migration instance. Open Migration Hub → Edit instance and add Corp ID, username, and password.';
  }
  return null;
}

function OrDivider() {
  return (
    <div className="relative my-5">
      <div className="absolute inset-0 flex items-center">
        <div className="w-full border-t border-gray-200" />
      </div>
      <div className="relative flex justify-center">
        <span className="bg-white px-2 text-xs font-medium uppercase tracking-wide text-gray-400">or</span>
      </div>
    </div>
  );
}

function householdShowsImportedBadge(row: HouseholdSummaryRow): boolean {
  return !!(row.isPendingUpdate || row.appliedInBatch);
}

type ApplyResultModalContent = {
  title: string;
  lines: string[];
  householdNames?: string[];
  variant: 'success' | 'warning' | 'info';
  errorNote?: string;
};

function buildApplyResultModalContent(applyResult: MigrationApplyResult): ApplyResultModalContent | null {
  const results = applyResult.results || [];
  const errorRows = results.filter((row) => row.action === 'error');
  const created = results.filter((row) => row.action === 'create');
  const updated = results.filter((row) => row.action === 'update');
  const imported = results.filter((row) => row.action === 'imported');
  const locked = results.filter((row) => row.action === 'locked');

  if (applyResult.status === 'failed' && errorRows.length === 0) {
    return {
      title: 'Import did not complete',
      lines: ['Try Apply Import again or run the unstick SQL script, then retry.'],
      variant: 'warning'
    };
  }

  if (applyResult.status !== 'applied') {
    return null;
  }

  const lines: string[] = [];
  let title = 'Apply complete';
  let variant: ApplyResultModalContent['variant'] = errorRows.length ? 'warning' : 'success';

  if (created.length) {
    lines.push(`${created.length} household${created.length === 1 ? '' : 's'} imported.`);
  }
  if (updated.length) {
    lines.push(`${updated.length} pending migration enrollment${updated.length === 1 ? '' : 's'} rebuilt with current mappings.`);
  }
  if (!created.length && !updated.length && imported.length) {
    title = 'Already imported';
    variant = 'info';
    lines.push(`${imported.length} household${imported.length === 1 ? '' : 's'} already in AB365 as Pending Migration — no changes needed.`);
    lines.push('Check the Members page to finish payment and go-live steps.');
  }
  if (!created.length && !updated.length && !imported.length && (locked.length || (applyResult.skipCount ?? 0) > 0)) {
    title = 'No new imports';
    variant = 'info';
    lines.push('No new households were imported.');
    if (locked.length) lines.push(`${locked.length} already active in AB365.`);
  }

  if (!lines.length && errorRows.length === 0) {
    lines.push('Apply finished successfully.');
  }

  if (!lines.length) return null;

  const successRows = [...created, ...updated, ...imported];
  const householdNames = successRows
    .map((row) => row.primaryName || row.householdMemberId)
    .filter((name): name is string => !!name);

  return {
    title,
    lines,
    householdNames: householdNames.length > 0 && householdNames.length <= 10 ? householdNames : undefined,
    variant,
    errorNote: errorRows.length
      ? `${errorRows.length} household${errorRows.length === 1 ? '' : 's'} failed — see details below.`
      : undefined
  };
}

type PreviewPremiumLine = NonNullable<PreviewRow['premiumBreakdown']>[number];

function previewProductLineLabel(line: PreviewPremiumLine): string {
  return line.ab365ProductName || line.e123Label || line.label || `E123 pdid ${line.pdid}`;
}

function renderPreviewProductBreakdown(
  breakdown: PreviewRow['premiumBreakdown'],
  options?: { emphasizeMismatch?: boolean }
) {
  if (!breakdown?.length) return null;
  return (
    <ul className="mt-1.5 space-y-1.5">
      {breakdown.map((line, index) => {
        const mismatch = line.matchStatus === 'mismatch' || line.matchStatus === 'unknown';
        const showEmphasis = options?.emphasizeMismatch ? mismatch : true;
        const lineKey = `${line.pdid}-${line.benefitId ?? 'default'}-${line.productPricingId ?? index}`;
        return (
          <li
            key={lineKey}
            className={`rounded border px-2 py-1 ${
              showEmphasis && mismatch
                ? 'border-red-200 bg-red-50/80'
                : 'border-gray-200 bg-white/80'
            }`}
          >
            <div className={`font-medium ${showEmphasis && mismatch ? 'text-red-900' : 'text-gray-800'}`}>
              {previewProductLineLabel(line)}
            </div>
            {line.e123Label && line.ab365ProductName && line.e123Label !== line.ab365ProductName ? (
              <div className="text-gray-500">E123: {line.e123Label}</div>
            ) : null}
            {line.ab365PricingLabel ? (
              <div className="text-gray-500 truncate max-w-xs" title={line.ab365PricingLabel}>
                Tier: {line.ab365PricingLabel}
              </div>
            ) : null}
            <div className={showEmphasis && mismatch ? 'text-red-800' : 'text-gray-600'}>
              E123 ${line.e123Amount.toFixed(2)}
              {' · '}
              AB365 {line.ab365Amount != null ? `$${line.ab365Amount.toFixed(2)}` : '—'}
              {line.tobaccoUse ? ` · ${line.tobaccoUse === 'Yes' ? 'tobacco' : 'non-tobacco'}` : ''}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function isAlreadyImportedApplyResult(results?: MigrationApplyResult['results']): boolean {
  return !!results?.length && results.every((row) => (
    row.action === 'imported'
    || row.action === 'locked'
    || row.action === 'skip'
    || row.action === 'skipped'
  ));
}

function applyResultFromPoll(data: {
  status: string;
  applyProcessed: number;
  applyTotal: number;
  applyCreateCount: number;
  applySkipCount: number;
  applyErrorCount: number;
  results?: MigrationApplyResult['results'];
}): MigrationApplyResult {
  const errorRows = (data.results || []).filter((row) => row.action === 'error');
  const updateRows = (data.results || []).filter((row) => row.action === 'update');
  return {
    createCount: data.applyCreateCount ?? 0,
    updateCount: updateRows.length,
    skipCount: data.applySkipCount ?? 0,
    errorCount: errorRows.length || data.applyErrorCount || 0,
    processed: data.applyProcessed,
    status: data.status,
    results: data.results
  };
}

function ProgressBar({
  currentIndex,
  furthestIndex,
  onStepClick
}: {
  currentIndex: number;
  furthestIndex: number;
  onStepClick?: (index: number) => void;
}) {
  return (
    <nav aria-label="Migration wizard progress" className="mb-8">
      <ol className="flex items-center">
        {STEPS.map((step, idx) => {
          const isCompleted = idx < currentIndex;
          const isCurrent = idx === currentIndex;
          const isReachable = idx <= furthestIndex;
          const isClickable = !!onStepClick && isReachable && idx !== currentIndex;
          return (
            <li key={step} className={`flex items-center ${idx < STEPS.length - 1 ? 'flex-1' : ''}`}>
              <div className="flex flex-col items-center">
                <button
                  type="button"
                  disabled={!isClickable}
                  onClick={() => isClickable && onStepClick?.(idx)}
                  title={isClickable ? `Go to ${step}` : undefined}
                  aria-current={isCurrent ? 'step' : undefined}
                  className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors
                    ${isCompleted ? 'bg-oe-primary text-white' : ''}
                    ${isCurrent ? 'border-2 border-oe-primary text-oe-primary bg-white' : ''}
                    ${!isCompleted && !isCurrent ? 'border-2 border-gray-200 text-gray-400 bg-white' : ''}
                    ${isClickable ? 'cursor-pointer hover:ring-2 hover:ring-oe-primary/30 focus:outline-none focus:ring-2 focus:ring-oe-primary/40' : ''}
                    ${!isReachable ? 'opacity-60' : ''}
                    disabled:cursor-default`}
                >
                  {isCompleted ? <CheckCircle className="h-4 w-4" /> : idx + 1}
                </button>
                <span className={`mt-1 text-xs font-medium ${isCurrent ? 'text-oe-primary' : isCompleted ? 'text-oe-dark' : isReachable ? 'text-gray-500' : 'text-gray-400'}`}>
                  {step}
                </span>
              </div>
              {idx < STEPS.length - 1 && (
                <div className={`flex-1 h-0.5 mx-2 mt-[-1rem] ${idx < currentIndex ? 'bg-oe-primary' : 'bg-gray-200'}`} />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default function E123MigrationWizard() {
  const { batchId: routeBatchId } = useParams<{ batchId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const portalMode = isE123MigrationPortalMode();
  const freshStart = searchParams.get('fresh') === '1';
  const instanceId = searchParams.get('instanceId') || loadActiveMigrationInstance()?.instanceId || null;
  const [resumingSession, setResumingSession] = useState(false);
  /** True while GET /batches/:id is in flight for the current URL batch id. */
  const [batchHydrating, setBatchHydrating] = useState(false);

  const [stepIndex, setStepIndex] = useState(0);
  const [batch, setBatch] = useState<MigrationBatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentsLoadError, setAgentsLoadError] = useState<string | null>(null);
  const [agentCatalogNote, setAgentCatalogNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [brokerId, setBrokerId] = useState('');
  const [selectedAgentKey, setSelectedAgentKey] = useState('');
  const [includeDownline, setIncludeDownline] = useState(true);
  const [includeTerminatedHouseholds, setIncludeTerminatedHouseholds] = useState(false);
  const [agentLookup, setAgentLookup] = useState<AgentLookupResult | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  const [fetchStatus, setFetchStatus] = useState<string>('draft');
  const [fetchProgress, setFetchProgress] = useState({
    pagesCompleted: 0,
    membersLoaded: 0,
    rawUsersLoaded: 0,
    householdCount: 0,
    fetchPhase: null as string | null,
    householdsSaved: null as number | null,
    householdsTotal: null as number | null
  });
  const [fetchStale, setFetchStale] = useState(false);
  const pendingFetchRef = useRef(false);
  const fetchStartedAtRef = useRef<number | null>(null);
  /** While a batch-wide select/deselect is in flight, apply to rows loaded on other pages. */
  const bulkIncludeOverrideRef = useRef<boolean | null>(null);

  const [agentTreeConfigured, setAgentTreeConfigured] = useState(false);
  const [agentTreeNodeCount, setAgentTreeNodeCount] = useState(0);
  const [orgPreset, setOrgPreset] = useState<AgentOption | null>(null);
  const [orgBrokerDiscovering, setOrgBrokerDiscovering] = useState(false);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [manualBrokerInput, setManualBrokerInput] = useState('');
  const [manualLookupError, setManualLookupError] = useState<string | null>(null);

  const [householdRows, setHouseholdRows] = useState<HouseholdSummaryRow[]>([]);
  const [householdPage, setHouseholdPage] = useState(1);
  const [householdRowsPage, setHouseholdRowsPage] = useState(1);
  const [householdTotal, setHouseholdTotal] = useState(0);
  const [householdSearch, setHouseholdSearch] = useState('');
  const [householdLoading, setHouseholdLoading] = useState(false);
  const [selectionSummary, setSelectionSummary] = useState<BatchSelectionSummary | null>(null);
  const [selectionUpdating, setSelectionUpdating] = useState(false);
  const [advancedSelectionOpen, setAdvancedSelectionOpen] = useState(false);
  const [memberIdsPasteText, setMemberIdsPasteText] = useState('');
  const [memberIdsReplaceSelection, setMemberIdsReplaceSelection] = useState(true);
  const [memberIdsApplyMessage, setMemberIdsApplyMessage] = useState<string | null>(null);
  /** Incremented when IncludedInImport changes so downstream wizard steps refetch scoped data. */
  const [selectionRevision, setSelectionRevision] = useState(0);

  const [tenants, setTenants] = useState<MigrationTenantOption[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(false);
  const [tenantsError, setTenantsError] = useState<string | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [allProductsMapped, setAllProductsMapped] = useState(false);
  const [productMappingSummary, setProductMappingSummary] = useState({ totalGroups: 0, pendingGroups: 0 });

  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [previewPage, setPreviewPage] = useState(1);
  const [previewPageRowCount, setPreviewPageRowCount] = useState(0);
  const [previewTotal, setPreviewTotal] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewSummaryLoading, setPreviewSummaryLoading] = useState(false);
  const [summary, setSummary] = useState<{
    createCount: number;
    updateCount?: number;
    skipCount: number;
    lockedCount?: number;
    errorCount: number;
    total: number;
  } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyProgress, setApplyProgress] = useState<{
    status: string;
    applyProcessed: number;
    applyTotal: number;
  } | null>(null);
  const [applyResult, setApplyResult] = useState<MigrationApplyResult | null>(null);
  const [applyResultModalOpen, setApplyResultModalOpen] = useState(false);
  const [offsetProcessingFeeForPremiumMatch, setOffsetProcessingFeeForPremiumMatch] = useState(false);
  const [importSettingsSaving, setImportSettingsSaving] = useState(false);

  const batchId = batch?.BatchId || routeBatchId;

  const resolveStepIndex = useCallback((data: MigrationBatch): number => {
    if (data.Status === 'fetching') return 0;
    if (['applied', 'applying', 'failed'].includes(data.Status)) return 4;
    if (data.WizardStep >= 5) return 4;
    if (data.WizardStep >= 4 && data.TenantId) return 3;
    if (data.WizardStep >= 3 && data.TenantId) return 2;
    if (data.WizardStep >= 2 && data.TenantId) return 1;
    if (data.WizardStep >= 2) return 1;
    return 0;
  }, []);

  const isBatchFetchReady = useMemo(() => {
    const fs = normalizeMigrationBatchStatus(fetchStatus);
    const bs = normalizeMigrationBatchStatus(batch?.Status);
    if (fs === 'ready' || bs === 'ready') return true;
    if ((batch?.WizardStep ?? 0) >= 2) return true;
    if ((batch?.householdCount ?? 0) > 0) return true;
    if (householdTotal > 0) return true;
    return false;
  }, [fetchStatus, batch?.Status, batch?.WizardStep, batch?.householdCount, householdTotal]);

  /** Batch URL on step 0 always means member/household selection — never the agent catalog. */
  const step0MemberMode = stepIndex === 0 && !!routeBatchId;
  /** Agent catalog only on a brand-new import (/import?fresh=1) with no batch yet. */
  const needsAgentCatalog = stepIndex === 0 && !routeBatchId && !batchHydrating;
  /** Full-page spinner only on first batch load when we have no batch object yet. */
  const showBatchLoadSpinner = batchHydrating && !batch && !!routeBatchId;

  const furthestStepIndex = useMemo(() => {
    const fromBatch = batch ? resolveStepIndex(batch) : 0;
    return Math.max(stepIndex, fromBatch);
  }, [batch, stepIndex, resolveStepIndex]);

  const selectedTenantName = useMemo(() => {
    if (batch?.TenantName) return batch.TenantName;
    return tenants.find((tenant) => tenant.tenantId === selectedTenantId)?.name || '';
  }, [batch?.TenantName, selectedTenantId, tenants]);

  const crossTenantAgentStats = useMemo(() => {
    if (!batchId || !selectedTenantId) return null;
    const workspace = readAgentMappingWorkspaceCache(batchId, selectedTenantId, selectionRevision);
    if (!workspace?.crossTenantCount) return null;
    return {
      brokerCount: workspace.crossTenantCount,
      memberCount: workspace.crossTenantMemberCount ?? 0
    };
  }, [batchId, selectedTenantId, selectionRevision, stepIndex]);

  const previewCrossTenantCount = useMemo(
    () => previewRows.filter((row) => row.ab365AgentCrossTenant).length,
    [previewRows]
  );

  const fetchCoverage = useMemo(() => {
    if (!batch?.SummaryJson) return null;
    try {
      const parsed = JSON.parse(batch.SummaryJson) as { fetchCoverage?: {
        householdCount: number;
        primarySsnCount: number;
        dependentCount: number;
        dependentSsnCount: number;
        paymentMethodCount: number;
        paymentMaskedOnly: number;
      } };
      return parsed.fetchCoverage || null;
    } catch {
      return null;
    }
  }, [batch?.SummaryJson]);

  const applyBatchToState = useCallback((data: MigrationBatch) => {
    setBatch(data);
    setBrokerId(String(data.RootBrokerId || ''));
    setSelectedAgentKey(
      data.RootBrokerId
        ? `${data.RootBrokerId}-${data.IncludeDownline ? 1 : 0}`
        : ''
    );
    setIncludeDownline(!!data.IncludeDownline);
    setSelectedTenantId(data.TenantId || '');
    setFetchStatus(data.Status);
    if (data.Status === 'fetching') {
      fetchStartedAtRef.current = fetchStartedAtRef.current || Date.now();
    } else if (data.Status === 'ready' || data.Status === 'failed') {
      pendingFetchRef.current = false;
      fetchStartedAtRef.current = null;
      setFetchStale(false);
    }
    setFetchProgress({
      pagesCompleted: data.FetchPagesCompleted || 0,
      membersLoaded: data.householdCount ?? data.FetchMembersLoaded ?? 0,
      rawUsersLoaded: data.Status === 'fetching' ? (data.FetchMembersLoaded ?? 0) : 0,
      householdCount: data.householdCount ?? 0,
      ...(() => {
        const fp = parseBatchFetchProgress(data.SummaryJson);
        return {
          fetchPhase: fp.phase ?? (data.Status === 'fetching' ? 'contacting' : null),
          householdsSaved: fp.householdsSaved ?? null,
          householdsTotal: fp.householdsTotal ?? null
        };
      })()
    });
    const importSettings = parseBatchImportSettings(data.SummaryJson);
    setOffsetProcessingFeeForPremiumMatch(importSettings.offsetProcessingFeeForPremiumMatch === true);
    setIncludeTerminatedHouseholds(importSettings.includeTerminatedHouseholds === true);
  }, []);

  const hydrateBatch = useCallback(async (id: string): Promise<MigrationBatch> => {
    const res = await e123MigrationService.getBatch(id);
    if (!res.success || !res.data) throw new Error('Batch not found');
    applyBatchToState(res.data);
    if (isResumableBatchStatus(res.data.Status)) {
      saveActiveMigrationBatch(id);
    } else {
      clearActiveMigrationBatch();
      clearProductMappingDraft(id);
    }
    if (res.data.Status === 'ready') {
      e123MigrationService.getBatchHouseholds(id, 1, 50, '')
        .then((hRes) => {
          if (hRes.success && hRes.data?.selection) {
            setSelectionSummary(hRes.data.selection);
          }
        })
        .catch(() => { /* selection loads again on step 0 */ });
    }
    return res.data;
  }, [applyBatchToState]);

  useEffect(() => {
    if (!routeBatchId) return undefined;

    let cancelled = false;
    setBatchHydrating(true);
    hydrateBatch(routeBatchId)
      .then((data) => {
        if (cancelled) return;
        if (!wizardStepWasInitialized(routeBatchId)) {
          markWizardStepInitialized(routeBatchId);
          setStepIndex(resolveStepIndex(data));
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        setBatchHydrating(false);
      });

    return () => {
      cancelled = true;
    };
    // Only re-load when the URL batch id changes — not on manual step navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeBatchId]);

  useEffect(() => {
    if (routeBatchId) return;
    setBatchHydrating(false);

    if (freshStart) {
      clearActiveMigrationBatch();
      return;
    }

    const session = loadActiveMigrationBatch();
    if (!session?.batchId) return;

    setResumingSession(true);
    e123MigrationService.getBatch(session.batchId)
      .then((res) => {
        if (res.success && res.data && isResumableBatchStatus(res.data.Status)) {
          navigate(e123MigrationPath(`/import/${session.batchId}`), { replace: true });
          return;
        }
        clearActiveMigrationBatch();
      })
      .catch(() => clearActiveMigrationBatch())
      .finally(() => setResumingSession(false));
  }, [routeBatchId, freshStart, navigate]);

  useEffect(() => {
    if (stepIndex !== 0 || !routeBatchId || batch || batchHydrating) return undefined;

    let cancelled = false;
    hydrateBatch(routeBatchId).catch((err) => {
      if (!cancelled) setError(err.message);
    });
    return () => {
      cancelled = true;
    };
  }, [stepIndex, routeBatchId, batch, batchHydrating, hydrateBatch]);

  useEffect(() => {
    if (stepIndex !== 0 || !routeBatchId || batchHydrating) return undefined;

    const bs = normalizeMigrationBatchStatus(batch?.Status);
    if (bs === 'ready' && normalizeMigrationBatchStatus(fetchStatus) !== 'ready') {
      setFetchStatus('ready');
    }

    return undefined;
  }, [stepIndex, routeBatchId, batch?.Status, fetchStatus, batchHydrating]);

  const loadAgentStepState = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setAgentsLoading(true);
      setAgentsLoadError(null);
    }

    try {
      let treeNodeCount = 0;
      if (instanceId) {
        const treeRes = await e123MigrationService.getAgentTreeStatus(instanceId);
        if (treeRes.success && treeRes.data?.configured) {
          treeNodeCount = treeRes.data.nodeCount || 0;
          setAgentTreeConfigured(true);
          setAgentTreeNodeCount(treeNodeCount);
        } else {
          setAgentTreeConfigured(false);
          setAgentTreeNodeCount(0);
        }
      }

      const res = await e123MigrationService.getAgentOptions(true, instanceId);
      if (res.success && res.data) {
        setOrgPreset(res.data.presets?.[0] || null);
        setOrgBrokerDiscovering(!!res.data.diagnostics?.orgBrokerDiscovering);
        setAgentCatalogNote(
          (res.data.diagnostics?.notes || []).filter(Boolean).join(' ') || null
        );
        setAgentsLoadError(formatAgentCatalogLoadError(res.data.diagnostics));
        if (treeNodeCount > 0) {
          setAgentCatalogNote(
            `Agent tree uploaded (${treeNodeCount.toLocaleString()} agents). Browse the tree or enter a broker ID.`
          );
        }
      } else if (!options?.silent) {
        setAgentsLoadError(res.message || 'Failed to load import options');
      }
    } catch (err: unknown) {
      if (!options?.silent) {
        setAgentsLoadError(err instanceof Error ? err.message : 'Failed to load import options');
      }
    } finally {
      if (!options?.silent) setAgentsLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    if (!needsAgentCatalog) {
      setAgentsLoading(false);
      return;
    }
    void loadAgentStepState();
  }, [needsAgentCatalog, loadAgentStepState]);

  useEffect(() => {
    if (!needsAgentCatalog || agentTreeConfigured || orgPreset || !orgBrokerDiscovering) return undefined;
    const timer = window.setInterval(() => loadAgentStepState({ silent: true }), 5000);
    return () => window.clearInterval(timer);
  }, [needsAgentCatalog, orgPreset, orgBrokerDiscovering, loadAgentStepState]);

  const loadTenants = useCallback(async () => {
    setTenantsLoading(true);
    setTenantsError(null);
    try {
      const res = await e123MigrationService.listTenants(instanceId);
      if (res.success && Array.isArray(res.data)) {
        const normalized = res.data
          .map((row) => normalizeMigrationTenant(row))
          .filter((row): row is MigrationTenantOption => row != null);
        setTenants(normalized);
        if (portalMode && normalized.length === 1) {
          setSelectedTenantId(normalized[0].tenantId);
        }
        if (normalized.length === 0) {
          setTenantsError('No active tenants found.');
        }
      } else {
        setTenants([]);
        setTenantsError(res.message || 'Failed to load tenants');
      }
    } catch (err: unknown) {
      setTenants([]);
      setTenantsError(err instanceof Error ? err.message : 'Failed to load tenants');
    } finally {
      setTenantsLoading(false);
    }
  }, [instanceId, portalMode]);

  useEffect(() => {
    if (stepIndex === 1) {
      loadTenants();
    }
  }, [stepIndex, loadTenants]);

  useEffect(() => {
    const batchFetching = normalizeMigrationBatchStatus(batch?.Status) === 'fetching';
    const uiFetching = normalizeMigrationBatchStatus(fetchStatus) === 'fetching';
    const awaitingFetchStart = pendingFetchRef.current && normalizeMigrationBatchStatus(batch?.Status) === 'draft';
    if (!batchId || (!uiFetching && !batchFetching && !awaitingFetchStart)) return undefined;

    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      const res = await e123MigrationService.getFetchStatus(batchId);
      if (cancelled || !res.success) return;
      setFetchStatus(res.data.status);
      setFetchProgress({
        pagesCompleted: res.data.pagesCompleted,
        membersLoaded: res.data.householdCount ?? res.data.membersLoaded,
        rawUsersLoaded: res.data.rawUsersLoaded ?? res.data.membersLoaded,
        householdCount: res.data.householdCount ?? 0,
        fetchPhase: res.data.fetchPhase ?? null,
        householdsSaved: res.data.householdsSaved ?? null,
        householdsTotal: res.data.householdsTotal ?? null
      });
      if (res.data.status === 'fetching') {
        const startedAt = fetchStartedAtRef.current || Date.now();
        fetchStartedAtRef.current = startedAt;
        const elapsedMs = Date.now() - startedAt;
        const phase = res.data.fetchPhase;
        const isContacting = !phase || phase === 'contacting';
        const noProgress = (res.data.pagesCompleted || 0) === 0 && (res.data.rawUsersLoaded ?? res.data.membersLoaded ?? 0) === 0;
        setFetchStale(elapsedMs > 90000 && noProgress && isContacting);
      } else {
        pendingFetchRef.current = false;
        fetchStartedAtRef.current = null;
        setFetchStale(false);
      }
      if (res.data.status === 'ready') {
        await hydrateBatch(batchId);
      }
      if (res.data.status === 'failed') {
        setError(res.data.fetchError || 'Fetch failed');
      }
    };

    void poll();
    const timer = window.setInterval(() => { void poll(); }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [batchId, batch?.Status, fetchStatus, hydrateBatch]);

  const restartFetch = async () => {
    if (!batchId) return;
    setError(null);
    setFetchStale(false);
    pendingFetchRef.current = true;
    fetchStartedAtRef.current = Date.now();
    setFetchStatus('fetching');
    try {
      await e123MigrationService.patchBatch(batchId, {
        importSettings: { includeTerminatedHouseholds }
      });
      await e123MigrationService.restartFetch(batchId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to restart fetch');
    }
  };

  useEffect(() => {
    if (!batchId || stepIndex !== 0) return undefined;
    if (!isBatchFetchReady) return undefined;
    let cancelled = false;
    setHouseholdLoading(true);
    e123MigrationService.getBatchHouseholds(batchId, householdPage, 50, householdSearch)
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) {
          const override = bulkIncludeOverrideRef.current;
          const rows = (res.data.rows || []).map((row) => {
            if (override === null || row.alreadyMigrated) return row;
            return { ...row, includedInImport: override };
          });
          setHouseholdRows(rows);
          setHouseholdRowsPage(householdPage);
          setHouseholdTotal(res.data.total || 0);
          setSelectionSummary(res.data.selection || null);
        } else if (!cancelled) {
          setError(res.message || 'Failed to load households');
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(migrationErrorMessage(err, 'Failed to load households'));
        }
      })
      .finally(() => {
        if (!cancelled) setHouseholdLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [batchId, isBatchFetchReady, householdPage, householdSearch, stepIndex]);

  const loadPreviewSummary = useCallback(async (isCancelled?: () => boolean) => {
    if (!batchId) return;
    setPreviewSummaryLoading(true);
    try {
      const summaryRes = await e123MigrationService.getSummary(batchId);
      if (isCancelled?.()) return;
      if (summaryRes.success && summaryRes.data) setSummary(summaryRes.data);
    } finally {
      if (!isCancelled?.()) setPreviewSummaryLoading(false);
    }
  }, [batchId]);

  const loadPreviewPage = useCallback(async (isCancelled?: () => boolean) => {
    if (!batchId) return;

    setPreviewLoading(true);
    setPreviewRows([]);
    setPreviewPageRowCount(0);
    setError(null);

    try {
      let offset = 0;
      let isFirstChunk = true;
      while (true) {
        const chunkSize = isFirstChunk ? PREVIEW_FIRST_CHUNK_SIZE : PREVIEW_CHUNK_SIZE;
        const previewRes = await e123MigrationService.getPreview(
          batchId,
          previewPage,
          PREVIEW_PAGE_SIZE,
          { chunkOffset: offset, chunkSize }
        );
        if (isCancelled?.()) return;
        if (!previewRes.success || !previewRes.data) {
          throw new Error(previewRes.message || 'Failed to load import preview');
        }

        const data = previewRes.data;
        if (data.total != null) setPreviewTotal(data.total);
        if (data.pageRowCount != null) setPreviewPageRowCount(data.pageRowCount);
        if (data.selection) setSelectionSummary(data.selection);
        setPreviewRows((prev) => [...prev, ...(data.rows || [])]);

        if (data.chunkComplete !== false) break;
        offset += data.chunkSize ?? chunkSize;
        isFirstChunk = false;
      }
    } catch (err: unknown) {
      if (!isCancelled?.()) {
        setError(migrationErrorMessage(err, 'Failed to load import preview'));
      }
    } finally {
      if (!isCancelled?.()) setPreviewLoading(false);
    }

    if (!isCancelled?.()) {
      void loadPreviewSummary(isCancelled);
    }
  }, [batchId, previewPage, loadPreviewSummary]);

  useEffect(() => {
    if (stepIndex !== 4 || !batchId) return undefined;
    let cancelled = false;
    void loadPreviewPage(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [stepIndex, batchId, previewPage, selectionRevision, offsetProcessingFeeForPremiumMatch, loadPreviewPage]);

  useEffect(() => {
    if (!applying) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [applying]);

  const handleOffsetProcessingFeeToggle = async (checked: boolean) => {
    if (!batchId) return;
    setOffsetProcessingFeeForPremiumMatch(checked);
    setImportSettingsSaving(true);
    setError(null);
    try {
      const res = await e123MigrationService.patchBatch(batchId, {
        importSettings: { offsetProcessingFeeForPremiumMatch: checked }
      });
      if (res.success && res.data) {
        setBatch(res.data);
      }
      bumpSelectionRevision();
    } catch (err: unknown) {
      setOffsetProcessingFeeForPremiumMatch(!checked);
      setError(migrationErrorMessage(err, 'Failed to save import setting'));
    } finally {
      setImportSettingsSaving(false);
    }
  };

  const refreshHouseholds = useCallback(async (options?: { silent?: boolean }) => {
    if (!batchId || !isBatchFetchReady) return;
    if (!options?.silent) setHouseholdLoading(true);
    try {
      const res = await e123MigrationService.getBatchHouseholds(batchId, householdPage, 50, householdSearch);
      if (res.success && res.data) {
        setHouseholdRows(res.data.rows || []);
        setHouseholdTotal(res.data.total || 0);
        setSelectionSummary(res.data.selection || null);
      }
    } finally {
      if (!options?.silent) setHouseholdLoading(false);
    }
  }, [batchId, isBatchFetchReady, householdPage, householdSearch]);

  const bumpSelectionRevision = useCallback(() => {
    if (batchId) clearAgentMappingWorkspaceCacheForBatch(batchId);
    setSelectionRevision((revision) => revision + 1);
    setPreviewRows([]);
    setPreviewPage(1);
    setPreviewTotal(0);
    setSummary(null);
  }, [batchId]);

  const updateSelection = async (payload: {
    batchHouseholdIds?: string[];
    included?: boolean;
    all?: boolean;
    search?: string;
  }) => {
    if (!batchId) return;
    const isBulkAll = payload.all === true;

    if (isBulkAll && payload.included !== undefined) {
      bulkIncludeOverrideRef.current = payload.included;
      setHouseholdRows((prev) => prev.map((row) => (
        row.alreadyMigrated ? row : { ...row, includedInImport: payload.included! }
      )));
      setSelectionSummary((prev) => {
        if (!prev) return prev;
        const selectableTotal = Math.max(0, (prev.totalCount ?? 0) - (prev.alreadyMigratedCount ?? 0));
        return {
          ...prev,
          selectedCount: payload.included ? selectableTotal : 0
        };
      });
    } else if (payload.batchHouseholdIds && payload.included !== undefined) {
      const idSet = new Set(payload.batchHouseholdIds);
      const delta = payload.included ? 1 : -1;
      setHouseholdRows((prev) => prev.map((row) => (
        idSet.has(row.batchHouseholdId)
          ? { ...row, includedInImport: payload.included! }
          : row
      )));
      setSelectionSummary((prev) => {
        if (!prev) return prev;
        const next = Math.max(0, (prev.selectedCount ?? 0) + delta * idSet.size);
        return { ...prev, selectedCount: next };
      });
    }

    setSelectionUpdating(true);
    try {
      const res = await e123MigrationService.updateHouseholdSelection(batchId, payload);
      if (res.success && res.data) {
        setSelectionSummary(res.data);
        bumpSelectionRevision();
        if (isBulkAll) {
          bulkIncludeOverrideRef.current = null;
          await refreshHouseholds({ silent: true });
        }
      } else {
        if (isBulkAll) bulkIncludeOverrideRef.current = null;
        setError(res.message || 'Failed to update selection');
        await refreshHouseholds({ silent: true });
      }
    } catch (err: unknown) {
      bulkIncludeOverrideRef.current = null;
      setError(migrationErrorMessage(err, 'Failed to update selection'));
      await refreshHouseholds({ silent: true });
    } finally {
      setSelectionUpdating(false);
    }
  };

  const lookupBrokerInE123 = useCallback(async (brokerIdRaw: string | number) => {
    const trimmed = String(brokerIdRaw).trim();
    if (!trimmed || !/^\d+$/.test(trimmed)) {
      throw new Error('Enter a numeric E123 broker ID.');
    }
    const res = await e123MigrationService.lookupAgent(Number(trimmed), instanceId);
    if (!res.success || !res.data?.agent?.id) {
      throw new Error('Broker ID not found in E123.');
    }
    return { brokerId: trimmed, lookup: res.data };
  }, [instanceId]);

  const onAgentTreeSelect = async (agent: AgentOption) => {
    const key = `${agent.rootBrokerId}-${agent.includeDownline !== false ? 1 : 0}`;
    setSelectedAgentKey(key);
    setBrokerId(String(agent.rootBrokerId));
    setIncludeDownline(agent.includeDownline !== false);
    setManualBrokerInput(String(agent.rootBrokerId));
    setManualLookupError(null);
    setAgentLookup(null);
    setError(null);
    setLookupLoading(true);
    try {
      const { lookup } = await lookupBrokerInE123(agent.rootBrokerId);
      setAgentLookup(lookup);
    } catch (err: unknown) {
      setBrokerId('');
      setSelectedAgentKey('');
      setAgentLookup(null);
      setError(err instanceof Error ? err.message : 'Agent lookup failed');
    } finally {
      setLookupLoading(false);
    }
  };

  const lookupManualBroker = async () => {
    setLookupLoading(true);
    setManualLookupError(null);
    setAgentLookup(null);
    setBrokerId('');
    setSelectedAgentKey('');
    setError(null);
    try {
      const { brokerId, lookup } = await lookupBrokerInE123(manualBrokerInput);
      setAgentLookup(lookup);
      setBrokerId(brokerId);
      setSelectedAgentKey(`${brokerId}-1`);
      setIncludeDownline(true);
    } catch (err: unknown) {
      setManualLookupError(err instanceof Error ? err.message : 'Broker lookup failed');
    } finally {
      setLookupLoading(false);
    }
  };

  const selectablePageRows = useMemo(
    () => householdRows.filter((row) => !row.alreadyMigrated),
    [householdRows]
  );

  const selectNewHouseholdsOnly = async () => {
    if (!batchId) return;
    setSelectionUpdating(true);
    setError(null);
    setMemberIdsApplyMessage(null);
    try {
      const res = await e123MigrationService.selectNewHouseholdsOnly(batchId);
      if (!res.success || !res.data?.selection) {
        setError(res.message || 'Failed to select new households');
        return;
      }
      setSelectionSummary(res.data.selection);
      bumpSelectionRevision();
      await refreshHouseholds({ silent: true });
    } catch (err: unknown) {
      setError(migrationErrorMessage(err, 'Failed to select new households'));
      await refreshHouseholds({ silent: true });
    } finally {
      setSelectionUpdating(false);
    }
  };

  const selectPendingMigrationOnly = async () => {
    if (!batchId) return;
    setSelectionUpdating(true);
    setError(null);
    setMemberIdsApplyMessage(null);
    try {
      const res = await e123MigrationService.selectPendingMigrationHouseholds(batchId);
      if (!res.success || !res.data?.selection) {
        setError(res.message || 'Failed to select pending migration households');
        return;
      }
      setSelectionSummary(res.data.selection);
      bumpSelectionRevision();
      await refreshHouseholds({ silent: true });
    } catch (err: unknown) {
      setError(migrationErrorMessage(err, 'Failed to select pending migration households'));
      await refreshHouseholds({ silent: true });
    } finally {
      setSelectionUpdating(false);
    }
  };

  const applyMemberIdsSelection = async () => {
    if (!batchId) return;
    const trimmed = memberIdsPasteText.trim();
    if (!trimmed) {
      setError('Paste one or more household member IDs first (comma, space, or newline separated).');
      return;
    }
    setSelectionUpdating(true);
    setError(null);
    setMemberIdsApplyMessage(null);
    try {
      const res = await e123MigrationService.selectHouseholdsByMemberIds(batchId, {
        householdMemberIds: trimmed,
        replaceSelection: memberIdsReplaceSelection
      });
      if (!res.success || !res.data?.selection) {
        setError(res.message || 'Failed to apply member ID selection');
        return;
      }
      setSelectionSummary(res.data.selection);
      bumpSelectionRevision();
      await refreshHouseholds({ silent: true });
      const parts = [`Selected ${res.data.matchedCount} of ${res.data.requestedCount} ID(s) in this batch.`];
      if (res.data.notInBatchCount > 0) {
        parts.push(`${res.data.notInBatchCount} not found in batch${res.data.notInBatchIds.length ? `: ${res.data.notInBatchIds.join(', ')}${res.data.notInBatchCount > res.data.notInBatchIds.length ? '…' : ''}` : ''}.`);
      }
      setMemberIdsApplyMessage(parts.join(' '));
    } catch (err: unknown) {
      setError(migrationErrorMessage(err, 'Failed to apply member ID selection'));
      await refreshHouseholds({ silent: true });
    } finally {
      setSelectionUpdating(false);
    }
  };

  const pageAllSelected = selectablePageRows.length > 0
    && selectablePageRows.every((row) => row.includedInImport);

  const pageSomeSelected = selectablePageRows.some((row) => row.includedInImport) && !pageAllSelected;

  const fetchProgressPct = useMemo(() => {
    const { fetchPhase, pagesCompleted, householdsSaved, householdsTotal } = fetchProgress;
    if (fetchPhase === 'persisting' && householdsTotal && householdsTotal > 0) {
      return Math.min(99, 55 + Math.round(((householdsSaved ?? 0) / householdsTotal) * 44));
    }
    if (fetchPhase === 'contacting' || (!fetchPhase && pagesCompleted === 0)) return 8;
    if (pagesCompleted > 0) return Math.min(52, pagesCompleted * 18);
    return 5;
  }, [fetchProgress]);

  const needsValidatedBroker = needsAgentCatalog && !agentLookup?.agent;
  const manualBrokerNeedsLookup = useMemo(() => {
    const input = manualBrokerInput.trim();
    if (!input) return false;
    if (!agentLookup?.agent?.id) return true;
    return String(agentLookup.agent.id) !== input;
  }, [manualBrokerInput, agentLookup]);
  const selectedHouseholdCount = selectionSummary?.selectedCount ?? 0;
  const canContinueFromMemberStep = !isBatchFetchReady || selectedHouseholdCount > 0;

  const startBatchAndFetch = async () => {
    if (!brokerId.trim()) {
      setError('Select an E123 agent or look up a broker ID first.');
      return;
    }
    if (!agentLookup?.agent?.id || String(agentLookup.agent.id) !== String(brokerId).trim()) {
      setError('Broker must be verified in E123 before starting the fetch. Use Look up or select from the agent tree.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await e123MigrationService.createBatch({
        rootBrokerId: Number(brokerId),
        rootAgentLabel: agentLookup?.agent?.label,
        includeDownline,
        instanceId,
        importSettings: { includeTerminatedHouseholds }
      });
      if (!res.success || !res.data) throw new Error('Failed to create batch');
      setBatch(res.data);
      pendingFetchRef.current = true;
      fetchStartedAtRef.current = Date.now();
      setFetchStatus('fetching');
      setFetchStale(false);
      saveActiveMigrationBatch(res.data.BatchId);
      navigate(e123MigrationPath(`/import/${res.data.BatchId}`), { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to start import');
    } finally {
      setLoading(false);
    }
  };

  const saveTenantAndContinue = async () => {
    if (!batchId || !selectedTenantId) {
      setError('Select a tenant');
      return;
    }
    setLoading(true);
    try {
      await e123MigrationService.patchBatch(batchId, {
        tenantId: selectedTenantId,
        wizardStep: 3,
        saveAgentMapping: true,
        rootAgentLabel: agentLookup?.agent?.label || batch?.RootAgentLabel
      });
      setStepIndex(2);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save tenant');
    } finally {
      setLoading(false);
    }
  };

  const batchApplyLocked = batch?.Status === 'applying'
    && applyResult?.status !== 'applied'
    && applyResult?.status !== 'failed'
    && !applying
    && !isAlreadyImportedApplyResult(applyResult?.results);
  const batchApplyStale = useMemo(() => {
    if (!batchApplyLocked || !batch?.ModifiedUtc) return false;
    const ageMs = Date.now() - new Date(batch.ModifiedUtc).getTime();
    const incomplete = (batch.ApplyProcessed || 0) < (batch.ApplyTotal || 1);
    return ageMs > 2 * 60 * 1000 && incomplete;
  }, [batchApplyLocked, batch?.ModifiedUtc, batch?.ApplyProcessed, batch?.ApplyTotal]);

  const runApply = async (options: { force?: boolean } = {}) => {
    if (!batchId || applying) return;
    let force = options.force === true;
    if (batchApplyLocked && !force) {
      const ok = window.confirm(
        'This batch is locked in "applying" state — usually from a prior attempt that did not finish. '
        + 'Force apply will clear the lock and retry. Continue?'
      );
      if (!ok) return;
      force = true;
    }
    const selectedPending = selectionSummary?.selectedPendingCount ?? 0;
    const selectedNew = selectionSummary?.selectedNewCount
      ?? Math.max(0, (selectionSummary?.selectedCount ?? 0) - selectedPending);
    if (selectedPending > 0) {
      const parts: string[] = [];
      if (selectedNew > 0) parts.push(`import ${selectedNew} new household(s)`);
      parts.push(`re-sync ${selectedPending} pending migration household(s) with current mappings`);
      const ok = window.confirm(
        `Apply will ${parts.join(' and ')}. Continue?`
      );
      if (!ok) return;
    }
    const loadedMismatchCount = previewRows.filter((row) => row.premiumMismatch).length;
    if (loadedMismatchCount > 0) {
      const previewPageCount = Math.max(1, Math.ceil(previewTotal / PREVIEW_PAGE_SIZE));
      const mismatchScope = previewLoading || previewRows.length < (previewPageRowCount || PREVIEW_PAGE_SIZE)
        ? `among the ${previewRows.length} preview row(s) loaded so far on page ${previewPage}`
        : previewTotal > PREVIEW_PAGE_SIZE
          ? `on preview page ${previewPage} of ${previewPageCount} (other pages not checked here)`
          : 'in this preview';
      const ok = window.confirm(
        `${loadedMismatchCount} household(s) ${mismatchScope} have a premium mismatch between E123 and AB365. `
        + `Apply will still import all ${selectedHouseholdCount} selected household(s), not just this preview page. `
        + 'Continuing may create enrollments at the wrong premium. Continue?'
      );
      if (!ok) return;
    } else if (selectedHouseholdCount > 0 && previewTotal > PREVIEW_PAGE_SIZE) {
      const ok = window.confirm(
        `Apply will import all ${selectedHouseholdCount} selected household(s). `
        + `The preview table is paginated (${previewTotal} total) — only page ${previewPage} is shown. Continue?`
      );
      if (!ok) return;
    }
    setApplying(true);
    setError(null);
    setApplyResult(null);
    setApplyResultModalOpen(false);
    setApplyProgress({
      status: 'applying',
      applyProcessed: 0,
      applyTotal: previewTotal || selectionSummary?.selectedCount || 1
    });

    try {
      const res = await e123MigrationService.applyBatch(batchId, { force });
      if (!res.success) {
        setError(res.message || 'Apply failed');
        return;
      }

      const finalStatus = res.data?.started
        ? await e123MigrationService.pollApplyUntilDone(batchId, (data) => {
          setApplyProgress({
            status: data.status,
            applyProcessed: data.applyProcessed,
            applyTotal: data.applyTotal
          });
          if (
            data.status === 'applied'
            || data.status === 'failed'
            || ((data.results?.length ?? 0) > 0 && data.applyTotal > 0 && data.applyProcessed >= data.applyTotal)
          ) {
            setApplyResult(applyResultFromPoll(data));
          }
        })
        : null;

      const result = finalStatus
        ? applyResultFromPoll(finalStatus)
        : {
          createCount: res.data?.createCount ?? 0,
          updateCount: res.data?.updateCount ?? 0,
          skipCount: res.data?.skipCount ?? 0,
          lockedCount: res.data?.lockedCount ?? 0,
          errorCount: res.data?.errorCount ?? 0,
          processed: res.data?.processed ?? 0,
          status: res.data?.status ?? 'applied',
          results: res.data?.results
        };

      setApplyResult(result);
      if (buildApplyResultModalContent(result)) {
        setApplyResultModalOpen(true);
      }
      setSummary({
        createCount: result.createCount,
        updateCount: result.updateCount ?? 0,
        skipCount: result.skipCount,
        lockedCount: result.lockedCount ?? 0,
        errorCount: result.errorCount,
        total: result.processed ?? 0
      });

      const alreadyImported = isAlreadyImportedApplyResult(result.results);
      const realErrorCount = (result.results || []).filter((row) => row.action === 'error').length;
      const succeeded = result.status === 'applied' || (alreadyImported && realErrorCount === 0);

      const resyncedRows = (result.results || []).filter((row) => row.action === 'update');

      if (succeeded && resyncedRows.length > 0) {
        setError(null);
      } else if (succeeded && alreadyImported) {
        setError(null);
      } else if (succeeded && result.createCount + (result.updateCount ?? 0) > 0) {
        setError(null);
        clearActiveMigrationBatch();
        if (batchId) clearProductMappingDraft(batchId);
      } else if (result.status === 'failed' || realErrorCount > 0) {
        setError('Import failed — see household results below.');
      } else {
        setError(null);
      }

      setApplying(false);
      setApplyProgress(null);

      void (async () => {
        try {
          await hydrateBatch(batchId);
          const previewRes = await e123MigrationService.getPreview(batchId, previewPage, PREVIEW_PAGE_SIZE);
          if (previewRes.success && previewRes.data) {
            setPreviewRows(previewRes.data.rows || []);
            setPreviewPageRowCount(previewRes.data.pageRowCount ?? previewRes.data.rows?.length ?? 0);
            setPreviewTotal(previewRes.data.total || 0);
          }
          void e123MigrationService.getSummary(batchId).then((summaryRes) => {
            if (summaryRes.success && summaryRes.data) setSummary(summaryRes.data);
          });
        } catch {
          /* preview refresh is best-effort — result already shown */
        }
      })();
    } catch (err: unknown) {
      setError(migrationErrorMessage(err, 'Apply failed'));
    } finally {
      setApplying(false);
      setApplyProgress(null);
    }
  };

  const goToStep = useCallback((idx: number) => {
    if (idx < 0 || idx >= STEPS.length || idx > furthestStepIndex) return;
    setStepIndex(idx);
    setError(null);
  }, [furthestStepIndex]);

  const goBack = () => {
    if (stepIndex === 0) {
      navigate(e123MigrationPath());
      return;
    }
    goToStep(stepIndex - 1);
  };

  const footer = (
    <div className="sticky bottom-0 bg-white border-t border-gray-200 px-6 py-4 flex items-center justify-between mt-8">
      <button
        type="button"
        onClick={goBack}
        className="inline-flex items-center px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
      >
        <ArrowLeft className="h-4 w-4 mr-2" />
        {stepIndex === 0 ? 'Cancel' : 'Back'}
      </button>
      <div>
        {stepIndex === 0 && (
          <button
            type="button"
            disabled={loading || fetchStatus === 'fetching' || (batch && !isBatchFetchReady && !!routeBatchId && fetchStatus !== 'failed') || !canContinueFromMemberStep || needsValidatedBroker}
            onClick={async () => {
              if (routeBatchId && isBatchFetchReady && batchId) {
                if (selectedHouseholdCount < 1) {
                  setError('Select at least one household to continue.');
                  return;
                }
                await e123MigrationService.patchBatch(batchId, { wizardStep: 2 });
                setStepIndex(1);
              } else {
                startBatchAndFetch();
              }
            }}
            title={isBatchFetchReady && selectedHouseholdCount < 1 ? 'Select at least one household to continue' : undefined}
            className="inline-flex items-center px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading || fetchStatus === 'fetching' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            {fetchStatus === 'fetching' ? 'Fetching...' : routeBatchId && isBatchFetchReady ? 'Next' : 'Start Fetch & Continue'}
            <ArrowRight className="h-4 w-4 ml-2" />
          </button>
        )}
        {stepIndex === 1 && (
          <button type="button" onClick={saveTenantAndContinue} disabled={loading || !selectedTenantId} className="inline-flex items-center px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
            Next <ArrowRight className="h-4 w-4 ml-2" />
          </button>
        )}
        {stepIndex === 2 && (
          <button
            type="button"
            onClick={async () => {
              if (batchId) {
                await e123MigrationService.patchBatch(batchId, { wizardStep: 4 });
              }
              setStepIndex(3);
            }}
            className="inline-flex items-center px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
          >
            Next <ArrowRight className="h-4 w-4 ml-2" />
          </button>
        )}
        {stepIndex === 3 && (
          <button
            type="button"
            onClick={async () => {
              if (!allProductsMapped && productMappingSummary.pendingGroups > 0) {
                const ok = window.confirm(
                  `${productMappingSummary.pendingGroups} E123 product(s) are not fully mapped or ignored. `
                  + 'Members will still import, but enrollments for those products will be skipped. '
                  + 'You can map products later and re-run this import to add enrollments for pending members. Continue to preview?'
                );
                if (!ok) return;
              }
              if (batchId) {
                await e123MigrationService.patchBatch(batchId, { wizardStep: 5 });
              }
              setStepIndex(4);
            }}
            className="inline-flex items-center px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
          >
            Preview <ArrowRight className="h-4 w-4 ml-2" />
          </button>
        )}
        {stepIndex === 4 && (
          <div className="flex items-center gap-2">
            {(selectionSummary?.selectedCount ?? 0) > 0 && (
              <div className="flex flex-col items-end gap-1">
                <button
                  type="button"
                  onClick={() => runApply({ force: batchApplyLocked })}
                  disabled={applying}
                  className="inline-flex items-center px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {applying ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  {applying
                    ? 'Applying…'
                    : `Apply Import (${selectedHouseholdCount})`}
                </button>
                {batchApplyLocked && !applying ? (
                  <span className="text-xs text-amber-700 max-w-[16rem] text-right leading-snug">
                    Prior run stopped partway — apply clears the lock and retries all {selectedHouseholdCount} selected.
                  </span>
                ) : !applying && selectedHouseholdCount > 0 ? (
                  <span className="text-xs text-gray-500 max-w-[16rem] text-right leading-snug">
                    Imports all {selectedHouseholdCount} selected — preview table is paginated only.
                  </span>
                ) : null}
              </div>
            )}
            {batch?.Status === 'applied' && (
              <button
                type="button"
                onClick={() => {
                  clearActiveMigrationBatch();
                  if (batchId) clearProductMappingDraft(batchId);
                  navigate(e123MigrationPath());
                }}
                className={`inline-flex items-center px-4 py-2 rounded-lg ${
                  (selectionSummary?.selectedCount ?? 0) > 0
                    ? 'border border-gray-300 text-gray-700 hover:bg-gray-50'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                Done
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="p-6 max-w-7xl mx-auto pb-24">
      <button type="button" onClick={() => navigate(e123MigrationPath())} className="text-sm text-gray-500 hover:text-gray-700 mb-4 inline-flex items-center">
        <ArrowLeft className="h-4 w-4 mr-1" /> Back to Migration Hub
      </button>
      {resumingSession && !routeBatchId ? (
        <div className="mb-4 text-sm text-gray-500 flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Resuming your in-progress import...
        </div>
      ) : null}
      {showBatchLoadSpinner ? (
        <div className="mb-4 text-sm text-gray-500 flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading import session...
        </div>
      ) : null}
      <ProgressBar
        currentIndex={stepIndex}
        furthestIndex={furthestStepIndex}
        onStepClick={goToStep}
      />

      {(error || (stepIndex === 0 && agentsLoadError && needsAgentCatalog)) && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 text-sm flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">{error || agentsLoadError}</div>
          {agentsLoadError && stepIndex === 0 && needsAgentCatalog ? (
            <button
              type="button"
              onClick={() => void loadAgentStepState()}
              disabled={agentsLoading}
              className="shrink-0 inline-flex items-center px-3 py-1.5 rounded-md border border-red-300 bg-white text-red-800 hover:bg-red-100 disabled:opacity-50 text-sm font-medium"
            >
              {agentsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Retry'}
            </button>
          ) : null}
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        {showBatchLoadSpinner ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-500">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading import session...
          </div>
        ) : null}
        {!showBatchLoadSpinner && stepIndex === 0 && (
          <div className="space-y-6">
            <div className="max-w-2xl space-y-4">
              {step0MemberMode ? (
                batch ? (
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm space-y-2">
                    <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Import root</div>
                    <div className="font-medium text-gray-900">
                      {batch.RootAgentLabel || batch.displayRootAgentLabel || `Broker ${batch.RootBrokerId}`}
                    </div>
                    <div className="text-xs text-gray-600">
                      Broker {batch.RootBrokerId}
                      {batch.IncludeDownline ? ' · Full downline' : ' · Direct only'}
                    </div>
                    <p className="text-xs text-gray-500 pt-1">
                      Update member checkboxes below. To import a different E123 root, start a new member import from the hub.
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading import details...
                  </div>
                )
              ) : needsAgentCatalog ? (
                <>
                  {!agentTreeConfigured && instanceId ? (
                    <E123CatalogUploadPanel
                      instanceId={instanceId}
                      compact
                      onImported={() => void loadAgentStepState()}
                    />
                  ) : null}

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Choose import root
                    </label>
                    <p className="text-xs text-gray-500 mb-4">
                      {agentTreeConfigured
                        ? 'Pick one: browse the uploaded agent tree or enter a broker ID.'
                        : 'Pick one: browse the uploaded agent tree, enter a broker ID, or import the full organization.'}
                      {agentsLoading ? (
                        <span className="block mt-1 text-blue-700">Loading…</span>
                      ) : null}
                    </p>

                    {agentTreeConfigured && instanceId ? (
                      <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
                        <div className="text-sm font-medium text-gray-800 mb-1">Browse agent tree</div>
                        <p className="text-xs text-gray-500 mb-3">
                          {agentTreeNodeCount.toLocaleString()} agents — expand nodes and click to select the import root.
                        </p>
                        <AgentTreePicker
                          instanceId={instanceId}
                          selectedAgentId={brokerId ? Number(brokerId) : null}
                          onSelect={(agent) => void onAgentTreeSelect(agent)}
                          disabled={fetchStatus === 'fetching' || lookupLoading}
                        />
                      </div>
                    ) : null}

                    {agentTreeConfigured ? <OrDivider /> : null}

                    <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
                      <label htmlFor="manual-broker-id" className="block text-sm font-medium text-gray-700 mb-1">
                        Enter broker ID
                      </label>
                      <p className="text-xs text-gray-500 mb-3">
                        Must exist in E123 — we verify via the agent API before you can start the fetch.
                      </p>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input
                          id="manual-broker-id"
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={manualBrokerInput}
                          onChange={(e) => {
                            setManualBrokerInput(e.target.value.replace(/\D/g, ''));
                            setManualLookupError(null);
                            if (agentLookup) {
                              setAgentLookup(null);
                              setBrokerId('');
                              setSelectedAgentKey('');
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && manualBrokerNeedsLookup) void lookupManualBroker();
                          }}
                          placeholder="e.g. 783390"
                          disabled={fetchStatus === 'fetching' || lookupLoading}
                          className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
                        />
                        {manualBrokerNeedsLookup ? (
                          <button
                            type="button"
                            onClick={() => void lookupManualBroker()}
                            disabled={fetchStatus === 'fetching' || lookupLoading || !manualBrokerInput.trim()}
                            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 shrink-0"
                          >
                            {lookupLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                            Look up
                          </button>
                        ) : null}
                      </div>
                      {manualLookupError ? (
                        <p className="mt-2 text-sm text-red-700">{manualLookupError}</p>
                      ) : null}
                    </div>

                    {orgPreset && !agentTreeConfigured ? (
                      <>
                        <OrDivider />
                        <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
                          <div className="text-sm font-medium text-gray-800 mb-1">Import full organization</div>
                          <p className="text-xs text-gray-500 mb-3">
                            Import all members under the top-level org broker ({orgPreset.rootBrokerId}) and full downline.
                          </p>
                          <button
                            type="button"
                            onClick={() => void onAgentTreeSelect(orgPreset)}
                            disabled={fetchStatus === 'fetching' || lookupLoading}
                            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md border border-blue-600 text-blue-700 text-sm font-medium hover:bg-blue-50 disabled:opacity-50"
                          >
                            {lookupLoading && brokerId === String(orgPreset.rootBrokerId) ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : null}
                            {orgPreset.label || orgPreset.rootAgentLabel || `Broker ${orgPreset.rootBrokerId}`}
                          </button>
                        </div>
                      </>
                    ) : null}

                    {agentCatalogNote && !agentTreeConfigured ? (
                      <p className="mt-2 text-xs text-gray-500">{agentCatalogNote}</p>
                    ) : null}
                  </div>

                  {agentLookup?.agent ? (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-green-100 text-green-800">
                          Verified in E123
                        </span>
                        <span className="font-medium text-gray-900">{agentLookup.agent.label}</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1">Broker ID {agentLookup.agent.id}</div>
                      {agentLookup.parentChain.length > 0 ? (
                        <div className="text-gray-600 mt-1">
                          Upline: {agentLookup.parentChain.map((p) => p.label).join(' → ')}
                        </div>
                      ) : null}
                    </div>
                  ) : needsValidatedBroker ? (
                    <p className="text-xs text-gray-500">
                      Look up a broker ID or select one from the agent tree to enable Start Fetch.
                    </p>
                  ) : null}

                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={includeDownline}
                      onChange={(e) => setIncludeDownline(e.target.checked)}
                      disabled={fetchStatus === 'fetching'}
                    />
                    Include entire downline
                  </label>
                  <label className="flex items-start gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={includeTerminatedHouseholds}
                      onChange={(e) => setIncludeTerminatedHouseholds(e.target.checked)}
                      disabled={fetchStatus === 'fetching'}
                      className="mt-0.5"
                    />
                    <span>
                      Include terminated households
                      <span className="block text-xs text-gray-500 mt-0.5">
                        Off by default. When on, E123 members whose plans are cancelled are fetched and imported with termination dates from E123.
                      </span>
                    </span>
                  </label>
                </>
              ) : null}
            </div>

            {(fetchStatus === 'fetching' || (pendingFetchRef.current && batch?.Status === 'draft')) && (
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 max-w-2xl">
                <p className="text-sm text-gray-700 mb-2">Fetching E123 members...</p>
                <div className="w-full bg-gray-200 rounded-full h-2 mb-2 overflow-hidden">
                  <div
                    className="bg-blue-600 h-2 rounded-full transition-all duration-500"
                    style={{ width: `${fetchProgressPct}%` }}
                  />
                </div>
                <p className="text-xs text-gray-500">
                  {fetchProgress.fetchPhase === 'persisting' ? (
                    <>
                      Saving households — {fetchProgress.householdsSaved ?? 0} of {fetchProgress.householdsTotal ?? '?'} (
                      {fetchProgress.rawUsersLoaded || fetchProgress.membersLoaded} E123 users fetched)
                    </>
                  ) : fetchProgress.fetchPhase === 'contacting' || (fetchProgress.pagesCompleted === 0 && (fetchProgress.rawUsersLoaded || 0) === 0) ? (
                    <>Contacting E123… first page usually takes 30–60 seconds for large orgs</>
                  ) : (
                    <>
                      Page {fetchProgress.pagesCompleted} — {fetchProgress.rawUsersLoaded || fetchProgress.membersLoaded} raw E123 users fetched
                    </>
                  )}
                </p>
                {fetchStale ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <p className="text-xs text-amber-800">
                      Fetch has not started or stalled (common after a server restart). Retry to resume.
                    </p>
                    <button
                      type="button"
                      onClick={() => void restartFetch()}
                      className="px-2.5 py-1 rounded-lg border border-amber-300 bg-white text-xs font-medium text-amber-900 hover:bg-amber-50"
                    >
                      Retry fetch
                    </button>
                  </div>
                ) : null}
              </div>
            )}

            {fetchStatus === 'failed' && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 max-w-2xl space-y-2">
                <p className="text-sm text-red-800">E123 fetch failed.</p>
                <button
                  type="button"
                  onClick={() => void restartFetch()}
                  className="px-2.5 py-1 rounded-lg border border-red-300 bg-white text-xs font-medium text-red-900 hover:bg-red-50"
                >
                  Retry fetch
                </button>
              </div>
            )}

            {isBatchFetchReady && (
              <div className="space-y-4">
                {selectedHouseholdCount < 1 ? (
                  <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3">
                    Select at least one household to continue. Active (live) members cannot be selected.
                  </div>
                ) : (
                  <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-3">
                    Ready — {selectedHouseholdCount} of {selectionSummary?.totalCount ?? householdTotal} households selected
                    {selectionSummary?.selectedPendingCount ? (
                      <span> ({selectionSummary.selectedPendingCount} pending re-sync)</span>
                    ) : null}
                    {selectionSummary?.alreadyMigratedCount ? (
                      <span> ({selectionSummary.alreadyMigratedCount} active in AB365)</span>
                    ) : null}
                    {selectionSummary?.pendingUpdateCount && !selectionSummary?.selectedPendingCount ? (
                      <span> ({selectionSummary.pendingUpdateCount} pending migration not selected)</span>
                    ) : null}
                    {includeDownline ? ' from full downline' : ' (direct only)'}.
                  </div>
                )}

                {fetchCoverage ? (
                  <div className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-3 max-w-2xl space-y-1">
                    <div className="font-medium text-gray-900">E123 data coverage (this fetch)</div>
                    <div>
                      SSN: {fetchCoverage.primarySsnCount.toLocaleString()} of {fetchCoverage.householdCount.toLocaleString()} primaries
                      {fetchCoverage.dependentCount > 0 ? (
                        <span> · {fetchCoverage.dependentSsnCount.toLocaleString()} of {fetchCoverage.dependentCount.toLocaleString()} dependents</span>
                      ) : null}
                    </div>
                    <div>
                      Payment methods: {fetchCoverage.paymentMethodCount.toLocaleString()} with full account/card numbers
                      {fetchCoverage.paymentMaskedOnly > 0 ? (
                        <span className="text-amber-700"> · {fetchCoverage.paymentMaskedOnly.toLocaleString()} households have masked-only payment history in E123</span>
                      ) : null}
                    </div>
                    <p className="text-xs text-gray-500">
                      Full SSNs and payment numbers are stored encrypted on import. Payment methods are not sent to the processor until you add them in AB365 billing.
                    </p>
                  </div>
                ) : null}

                <div>
                  <div className="flex flex-wrap items-center justify-between mb-3 gap-3">
                    <div className="flex items-center gap-3 flex-wrap">
                      <h3 className="text-sm font-medium text-gray-700">
                        Member households ({householdTotal.toLocaleString()})
                      </h3>
                      <span className="text-xs text-gray-500">
                        Pending migration households are deselected by default — include them to re-sync on apply. Active members cannot be selected.
                      </span>
                      <div className="flex items-center gap-2 text-xs">
                        <button
                          type="button"
                          disabled={selectionUpdating}
                          onClick={() => void selectNewHouseholdsOnly()}
                          className="text-violet-700 hover:text-violet-800 disabled:opacity-50 font-medium"
                        >
                          Select new only
                        </button>
                        <span className="text-gray-300">|</span>
                        <button
                          type="button"
                          disabled={selectionUpdating || !(selectionSummary?.pendingUpdateCount ?? 0)}
                          onClick={() => void selectPendingMigrationOnly()}
                          className="text-violet-700 hover:text-violet-800 disabled:opacity-50 font-medium"
                          title="Select all imported — pending migration households for re-sync"
                        >
                          Select pending only
                        </button>
                        <span className="text-gray-300">|</span>
                        <button
                          type="button"
                          disabled={selectionUpdating}
                          onClick={() => updateSelection({ all: true, included: true })}
                          className="text-blue-600 hover:text-blue-700 disabled:opacity-50"
                        >
                          Select all
                        </button>
                        <span className="text-gray-300">|</span>
                        <button
                          type="button"
                          disabled={selectionUpdating}
                          onClick={() => updateSelection({ all: true, included: false })}
                          className="text-blue-600 hover:text-blue-700 disabled:opacity-50"
                        >
                          Deselect all
                        </button>
                        {householdSearch && (
                          <>
                            <span className="text-gray-300">|</span>
                            <button
                              type="button"
                              disabled={selectionUpdating}
                              onClick={() => updateSelection({ all: true, included: true, search: householdSearch })}
                              className="text-blue-600 hover:text-blue-700 disabled:opacity-50"
                            >
                              Select all filtered
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <input
                      type="search"
                      value={householdSearch}
                      onChange={(e) => {
                        setHouseholdSearch(e.target.value);
                        setHouseholdPage(1);
                      }}
                      placeholder="Search by member ID or name..."
                      className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm w-64"
                    />
                  </div>
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => setAdvancedSelectionOpen((open) => !open)}
                      className="text-xs text-gray-600 hover:text-gray-800 font-medium"
                    >
                      {advancedSelectionOpen ? 'Hide' : 'Show'} advanced selection by member ID
                    </button>
                    {advancedSelectionOpen ? (
                      <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-3">
                        <p className="text-xs text-gray-600">
                          Paste household member IDs (e.g. SW0002148) separated by commas, spaces, or new lines.
                          Active members in AB365 are skipped automatically.
                        </p>
                        <textarea
                          value={memberIdsPasteText}
                          onChange={(e) => {
                            setMemberIdsPasteText(e.target.value);
                            setMemberIdsApplyMessage(null);
                          }}
                          rows={4}
                          placeholder="SW0002148, SW0004959&#10;SW0030069"
                          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono"
                          disabled={selectionUpdating}
                        />
                        <div className="flex flex-wrap items-center gap-4 text-xs text-gray-700">
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="radio"
                              name="memberIdsSelectionMode"
                              checked={memberIdsReplaceSelection}
                              onChange={() => setMemberIdsReplaceSelection(true)}
                              disabled={selectionUpdating}
                            />
                            Select only these IDs
                          </label>
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="radio"
                              name="memberIdsSelectionMode"
                              checked={!memberIdsReplaceSelection}
                              onChange={() => setMemberIdsReplaceSelection(false)}
                              disabled={selectionUpdating}
                            />
                            Add these IDs to current selection
                          </label>
                          <button
                            type="button"
                            disabled={selectionUpdating || !memberIdsPasteText.trim()}
                            onClick={() => void applyMemberIdsSelection()}
                            className="ml-auto px-3 py-1.5 rounded-md bg-violet-600 text-white text-xs font-medium hover:bg-violet-700 disabled:opacity-50"
                          >
                            Apply IDs
                          </button>
                        </div>
                        {memberIdsApplyMessage ? (
                          <p className="text-xs text-green-800 bg-green-50 border border-green-100 rounded px-2 py-1.5">
                            {memberIdsApplyMessage}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  {householdLoading && householdRows.length === 0 ? (
                    <div className="flex items-center gap-2 text-sm text-gray-500 py-8 justify-center">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading members...
                    </div>
                  ) : (
                    <>
                      {householdLoading && householdRows.length > 0 ? (
                        <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 mb-2">
                          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                          {householdRowsPage !== householdPage ? (
                            <span>
                              Loading page {householdPage}… still showing page {householdRowsPage} until ready.
                            </span>
                          ) : (
                            <span>Refreshing members…</span>
                          )}
                        </div>
                      ) : null}
                      <div className={`overflow-x-auto border border-gray-200 rounded-lg ${householdLoading && householdRows.length > 0 ? 'opacity-60' : ''}`}>
                        <table className="min-w-full divide-y divide-gray-200 text-sm">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="py-2 px-3 w-10" title="Select or deselect all households on this page">
                                <input
                                  type="checkbox"
                                  checked={pageAllSelected}
                                  ref={(el) => {
                                    if (el) el.indeterminate = pageSomeSelected;
                                  }}
                                  disabled={selectionUpdating || selectablePageRows.length === 0}
                                  aria-label="Select all households on this page"
                                  onChange={(e) => updateSelection({
                                    batchHouseholdIds: selectablePageRows.map((row) => row.batchHouseholdId),
                                    included: e.target.checked
                                  })}
                                />
                              </th>
                              <th className="text-left py-2 px-3 text-gray-500 font-medium">Member ID</th>
                              <th className="text-left py-2 px-3 text-gray-500 font-medium">Primary</th>
                              <th className="text-left py-2 px-3 text-gray-500 font-medium">Email</th>
                              <th className="text-left py-2 px-3 text-gray-500 font-medium">Agent</th>
                              <th className="text-left py-2 px-3 text-gray-500 font-medium">Deps</th>
                              <th className="text-left py-2 px-3 text-gray-500 font-medium">Products</th>
                              {(batch?.TenantId || selectedTenantId) ? (
                                <th className="text-left py-2 px-3 text-gray-500 font-medium">Premium</th>
                              ) : null}
                              <th className="text-left py-2 px-3 text-gray-500 font-medium">Status</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100 bg-white">
                            {householdRows.map((row) => (
                              <tr key={row.batchHouseholdId} className={`hover:bg-gray-50 ${row.alreadyMigrated ? 'opacity-70' : ''} ${row.premiumMismatch ? 'bg-red-50/60' : ''}`}>
                                <td className="py-2 px-3">
                                  <input
                                    type="checkbox"
                                    checked={row.includedInImport && !row.alreadyMigrated}
                                    disabled={selectionUpdating || row.alreadyMigrated}
                                    onChange={(e) => updateSelection({
                                      batchHouseholdIds: [row.batchHouseholdId],
                                      included: e.target.checked
                                    })}
                                  />
                                </td>
                                <td className="py-2 px-3 font-mono text-xs">{row.householdMemberId}</td>
                                <td className="py-2 px-3">
                                  <span>{row.primaryName || '—'}</span>
                                  {householdShowsImportedBadge(row) ? (
                                    <span className="ml-2 inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-green-100 text-green-800">
                                      Imported
                                    </span>
                                  ) : null}
                                  {row.alreadyMigrated ? (
                                    <span className="ml-2 inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-100 text-amber-900">
                                      Active in AB365
                                    </span>
                                  ) : null}
                                </td>
                                <td className="py-2 px-3 text-gray-500 text-xs">{row.email || '—'}</td>
                                <td className="py-2 px-3 text-xs">
                                  {row.e123AgentName ? (
                                    <span
                                      className="text-gray-700"
                                      title={row.e123AgentBrokerId ? `E123 broker ${row.e123AgentBrokerId}` : undefined}
                                    >
                                      {row.e123AgentName}
                                    </span>
                                  ) : (
                                    <span className="text-gray-400">—</span>
                                  )}
                                </td>
                                <td className="py-2 px-3">{row.dependentCount}</td>
                                <td className="py-2 px-3">{row.productCount}</td>
                                {(batch?.TenantId || selectedTenantId) ? (
                                  <td className="py-2 px-3 text-xs">
                                    {row.e123PremiumTotal != null && row.ab365PremiumTotal != null ? (
                                      row.premiumMismatch ? (
                                        <span className="inline-flex flex-col text-red-800">
                                          <span className="font-semibold">Mismatch</span>
                                          <span>E123 ${row.e123PremiumTotal.toFixed(2)}</span>
                                          <span>AB365 ${row.ab365PremiumTotal.toFixed(2)}</span>
                                        </span>
                                      ) : (
                                        <span className="text-green-700 font-medium">
                                          ${row.e123PremiumTotal.toFixed(2)} match
                                        </span>
                                      )
                                    ) : (
                                      <span className="text-gray-400">—</span>
                                    )}
                                  </td>
                                ) : null}
                                <td className="py-2 px-3">
                                  {row.alreadyMigrated ? (
                                    <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-100 text-amber-900">
                                      Active in AB365
                                    </span>
                                  ) : row.isPendingUpdate || row.appliedInBatch ? (
                                    <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-violet-100 text-violet-800">
                                      Imported — pending migration
                                    </span>
                                  ) : row.premiumMismatch ? (
                                    <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-red-100 text-red-800">
                                      Premium mismatch
                                    </span>
                                  ) : row.includedInImport ? (
                                    <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-blue-100 text-blue-800">
                                      Selected
                                    </span>
                                  ) : (
                                    <span className="text-xs text-gray-400">Not selected</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                            {householdRows.length === 0 && (
                              <tr>
                                <td colSpan={(batch?.TenantId || selectedTenantId) ? 8 : 7} className="py-8 text-center text-gray-400">No households match your search.</td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                      {householdTotal > 50 && (
                        <div className="flex items-center gap-2 mt-3">
                          <button
                            type="button"
                            disabled={householdPage <= 1 || selectionUpdating}
                            onClick={() => setHouseholdPage((p) => p - 1)}
                            className="px-3 py-1 border rounded-lg text-sm disabled:opacity-50"
                          >
                            Prev
                          </button>
                          <span className="text-sm text-gray-500 inline-flex items-center gap-2">
                            Page {householdPage} of {Math.ceil(householdTotal / 50)}
                            {householdLoading ? (
                              <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                {householdRowsPage !== householdPage && householdRows.length > 0
                                  ? `(showing ${householdRowsPage})`
                                  : 'Loading…'}
                              </>
                            ) : selectionUpdating ? (
                              ' — updating selection...'
                            ) : null}
                          </span>
                          <button
                            type="button"
                            disabled={householdPage * 50 >= householdTotal || selectionUpdating || householdLoading}
                            onClick={() => setHouseholdPage((p) => p + 1)}
                            className="px-3 py-1 border rounded-lg text-sm disabled:opacity-50"
                          >
                            Next
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {!showBatchLoadSpinner && stepIndex === 1 && (
          <div className="max-w-xl space-y-4">
            <p className="text-sm text-gray-600">
              Importing {selectionSummary?.selectedCount ?? fetchProgress.membersLoaded ?? batch?.FetchMembersLoaded ?? 0} of{' '}
              {selectionSummary?.totalCount ?? fetchProgress.householdCount ?? 0} households for{' '}
              <strong>{batch?.RootAgentLabel || agentLookup?.agent?.label || `broker ${brokerId}`}</strong>
              {includeDownline ? ' (full downline)' : ' (direct only)'}.
                  {selectionSummary?.alreadyMigratedCount ? (
                    <span className="block mt-1 text-gray-500">
                      {selectionSummary.alreadyMigratedCount} households are active in AB365 and cannot be modified.
                    </span>
                  ) : null}
                  {selectionSummary?.pendingUpdateCount ? (
                    <span className="block mt-1 text-blue-700">
                      {selectionSummary.pendingUpdateCount} pending migration household(s) are deselected by default — select them on the member step to re-sync on apply.
                    </span>
                  ) : null}
            </p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Target Tenant</label>
              <p className="text-xs text-gray-500 mb-2">
                {portalMode
                  ? 'Households will be imported into your tenant.'
                  : 'Choose which AB365 tenant should receive these imported households.'}
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
          </div>
        )}

        {!showBatchLoadSpinner && stepIndex === 2 && batchId && selectedTenantId && !instanceId && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            This batch is not linked to a migration instance. Agent mappings require an instance.
          </div>
        )}

        {!showBatchLoadSpinner && stepIndex === 2 && batchId && selectedTenantId && instanceId && (
          <MigrationAgentMappingStep
            key={`agent-map-${selectionRevision}`}
            batchId={batchId}
            instanceId={instanceId}
            tenantId={selectedTenantId}
            tenantName={selectedTenantName}
            selectedHouseholdCount={selectionSummary?.selectedCount}
            selectionRevision={selectionRevision}
          />
        )}

        {!showBatchLoadSpinner && stepIndex === 3 && batchId && selectedTenantId && !instanceId && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            This batch is not linked to a migration instance. Product mappings require an instance.
          </div>
        )}

        {!showBatchLoadSpinner && stepIndex === 3 && batchId && selectedTenantId && instanceId && (
          <div className="space-y-6">
            <div className="rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900">
              Product pairings are saved for the entire migration instance and shared across all tenants.
              The tenant selector only affects which tenant owns newly created products.
              You can also manage mappings in{' '}
              <a
                href={`${e123MigrationPath('/products')}?tenantId=${selectedTenantId}${instanceId ? `&instanceId=${instanceId}` : ''}`}
                className="font-medium underline hover:text-violet-700"
              >
                Product Migration
              </a>
              .
            </div>
            {!allProductsMapped && productMappingSummary.pendingGroups > 0 ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                You can continue to Preview without mapping every product. Unmapped E123 products are skipped on import —
                members are created with only the enrollments you have mapped (or none). Map products later, then re-run
                this batch to add enrollments for households still in pending migration.
              </div>
            ) : null}
            <MigrationProductMappingStep
              key={`product-map-${selectionRevision}`}
              batchId={batchId}
              instanceId={instanceId}
              tenantId={selectedTenantId}
              tenantName={selectedTenantName}
              selectedHouseholdCount={selectionSummary?.selectedCount}
              onMappingChange={(allMapped, summary) => {
                setAllProductsMapped(allMapped);
                if (summary) setProductMappingSummary(summary);
              }}
            />
          </div>
        )}

        {!showBatchLoadSpinner && stepIndex === 4 && (
          <div className="space-y-4">
            {selectedHouseholdCount > 0 && !applying && (
              <div className="bg-blue-50 border border-blue-200 text-blue-900 rounded-lg p-4 text-sm">
                <strong>Apply imports all {selectedHouseholdCount} selected household{selectedHouseholdCount === 1 ? '' : 's'}.</strong>
                {' '}The table below is a paginated preview ({Math.min(PREVIEW_PAGE_SIZE, previewTotal || selectedHouseholdCount)} per page
                {previewTotal > PREVIEW_PAGE_SIZE
                  ? ` · ${previewTotal} total selected`
                  : ''}
                ) — use Prev/Next to review other pages before applying.
              </div>
            )}
            <label className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white p-4 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                checked={offsetProcessingFeeForPremiumMatch}
                disabled={importSettingsSaving || previewLoading || applying}
                onChange={(event) => {
                  void handleOffsetProcessingFeeToggle(event.target.checked);
                }}
              />
              <span>
                <span className="font-medium text-gray-900 block">
                  Offset processing fee $ amount to match existing E123 premium when possible
                </span>
                <span className="text-gray-500 mt-1 block">
                  Adjusts the PaymentProcessingFee enrollment or included processing fee on product rows by up to $15
                  (never below $0) so the migrated household total matches E123. Skips households when the gap is outside that range.
                </span>
              </span>
            </label>
            {(selectionSummary?.pendingUpdateCount ?? 0) > 0
              && !(selectionSummary?.selectedPendingCount ?? 0)
              && !applying && (
              <div className="bg-violet-50 border border-violet-200 text-violet-900 rounded-lg p-4 text-sm">
                <strong>{selectionSummary?.pendingUpdateCount}</strong> household(s) in this batch are already imported as pending migration.
                {' '}Select them on <strong>Select Members</strong> (or use Select all) to re-sync enrollments when you apply.
              </div>
            )}
            {(selectionSummary?.selectedPendingCount ?? 0) > 0 && !applying && (
              <div className="bg-violet-50 border border-violet-200 text-violet-900 rounded-lg p-4 text-sm">
                <strong>{selectionSummary.selectedPendingCount}</strong> pending migration household(s) selected —
                apply will rebuild their enrollments with current product mappings.
                {(summary?.updateCount ?? 0) > 0 ? (
                  <span> Preview shows <strong>{summary.updateCount}</strong> re-sync{summary.updateCount === 1 ? '' : 's'}.</span>
                ) : null}
              </div>
            )}
            {batchApplyLocked && !applying && (
              <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-4 text-sm">
                {batchApplyStale ? (
                  <>
                    A prior apply stopped partway ({batch?.ApplyProcessed ?? 0} of {batch?.ApplyTotal ?? 0} processed).
                    {' '}Use <strong>Apply Import ({selectedHouseholdCount})</strong> below — it clears the stale lock and retries all selected households.
                  </>
                ) : (
                  <>
                    Batch is locked in <strong>applying</strong> state from a recent run.
                    {' '}Use <strong>Apply Import ({selectedHouseholdCount})</strong> to clear the lock and retry all selected.
                  </>
                )}
              </div>
            )}
            {applying && (
              <div className="flex items-center gap-2 text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded-lg p-4">
                <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                Importing
                {applyProgress?.applyTotal
                  ? ` ${applyProgress.applyProcessed} of ${applyProgress.applyTotal} household(s)…`
                  : '…'}
                <span className="text-blue-700/80 text-xs">
                  (large batches can take over an hour — keep this tab open)
                </span>
              </div>
            )}
            {!previewLoading && summary?.total === 0 && !(selectionSummary?.selectedCount ?? 0) && batch?.Status !== 'applied' && (
              <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-4 text-sm">
                No households are selected for import. Go back to <strong>Select Members</strong> and check at least one household, then return here.
              </div>
            )}
            {!previewLoading && batch?.Status === 'applied' && !(selectionSummary?.selectedCount ?? 0) && (
              <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-4 text-sm">
                This batch was already applied. To import more households, go back to <strong>Select Members</strong>, check the rows you want, then return here and use <strong>Apply Import</strong>.
              </div>
            )}
            {!previewLoading && previewRows.some((row) => row.premiumMismatch) && (
              <div className="bg-red-50 border border-red-200 text-red-900 rounded-lg p-4 text-sm">
                {previewRows.filter((row) => row.premiumMismatch).length} household(s) on this preview page have a premium mismatch (highlighted below).
                {previewTotal > PREVIEW_PAGE_SIZE ? (
                  <span> Other pages were not checked in this view — apply still runs on all {selectedHouseholdCount} selected.</span>
                ) : null}
                {offsetProcessingFeeForPremiumMatch
                  ? ' You can still import — adjust mappings or disable the processing-fee offset if you want premiums to match first.'
                  : ' You can still import — fix mappings, enable the processing-fee offset when the gap is small, or proceed anyway.'}
                {' '}Use <strong>Apply Import ({selectedHouseholdCount})</strong> at the bottom; you&apos;ll be asked to confirm.
              </div>
            )}
            {!previewLoading && (crossTenantAgentStats || previewCrossTenantCount > 0) && (
              <div className="bg-red-50 border border-red-200 text-red-900 rounded-lg p-4 text-sm flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Cross-tenant agent mappings detected</p>
                  <p className="mt-1">
                    {crossTenantAgentStats ? (
                      <>
                        {crossTenantAgentStats.brokerCount} broker mapping
                        {crossTenantAgentStats.brokerCount === 1 ? '' : 's'} point to agents outside{' '}
                        {selectedTenantName || 'the selected tenant'}
                        {' '}({crossTenantAgentStats.memberCount.toLocaleString()} household
                        {crossTenantAgentStats.memberCount === 1 ? '' : 's'}).
                      </>
                    ) : (
                      <>
                        {previewCrossTenantCount} loaded household
                        {previewCrossTenantCount === 1 ? '' : 's'} ha
                        {previewCrossTenantCount === 1 ? 's' : 've'} a broker mapped to another tenant.
                      </>
                    )}
                    {' '}Re-map on <strong>Agent Mapping</strong> or households will import without an agent.
                  </p>
                </div>
              </div>
            )}
            {summary && !previewSummaryLoading && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  ['Create', summary.createCount, 'text-green-700 bg-green-50'],
                  ['Update', summary.updateCount ?? 0, 'text-violet-700 bg-violet-50'],
                  ['Active (skip)', summary.lockedCount ?? 0, 'text-amber-700 bg-amber-50'],
                  ['Errors', summary.errorCount, 'text-red-700 bg-red-50'],
                  ['Total', summary.total, 'text-blue-700 bg-blue-50']
                ].map(([label, count, cls]) => (
                  <div key={label as string} className={`rounded-lg p-4 ${cls as string}`}>
                    <div className="text-xs uppercase tracking-wide opacity-70">{label as string}</div>
                    <div className="text-2xl font-semibold">{count as number}</div>
                  </div>
                ))}
              </div>
            )}
            {applyResult && (() => {
              const errorRows = (applyResult.results || []).filter((row) => row.action === 'error');
              const successCount = applyResult.createCount + (applyResult.updateCount ?? 0);
              if (!errorRows.length) return null;
              return (
                <div className={`rounded-lg p-4 text-sm border ${
                  successCount > 0
                    ? 'bg-amber-50 border-amber-200 text-amber-900'
                    : 'bg-red-50 border-red-200 text-red-800'
                }`}>
                  <div className="font-semibold mb-2">
                    {successCount > 0
                      ? `${errorRows.length} household(s) failed`
                      : `Import failed for ${errorRows.length} household(s)`}
                  </div>
                  <ul className="space-y-2">
                    {errorRows.map((row) => (
                      <li key={row.batchHouseholdId || row.householdMemberId}>
                        <span className="font-medium">{row.primaryName || row.householdMemberId}</span>
                        {row.message ? (
                          <span className="block text-xs mt-0.5 opacity-90">{row.message}</span>
                        ) : (
                          <span className="block text-xs mt-0.5 opacity-90">Unknown error</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
            {previewSummaryLoading && !summary ? (
              <div className="flex items-center gap-2 text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                Calculating import totals across all selected households (runs after this page loads)…
              </div>
            ) : null}
            {previewLoading ? (
              <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                <span>
                  Loading preview page {previewPage}
                  {previewPageRowCount > 0
                    ? `… ${previewRows.length} of ${previewPageRowCount} households`
                    : '…'}
                </span>
              </div>
            ) : null}
            <div className={`overflow-x-auto ${previewLoading ? 'opacity-90' : ''}`}>
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead>
                  <tr>
                    <th className="text-left py-2 text-gray-500">Member ID</th>
                    <th className="text-left py-2 text-gray-500">Primary</th>
                    <th className="text-left py-2 text-gray-500">Tier</th>
                    <th className="text-left py-2 text-gray-500">Deps</th>
                    <th className="text-left py-2 text-gray-500">Mapped products</th>
                    <th className="text-left py-2 text-gray-500">AB365 Agent</th>
                    <th className="text-left py-2 text-gray-500">Premium</th>
                    <th className="text-left py-2 text-gray-500">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {previewRows.length === 0 && previewLoading ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-sm text-gray-400">
                        First households loading…
                      </td>
                    </tr>
                  ) : null}
                  {previewRows.map((row) => (
                    <tr key={row.batchHouseholdId} className={row.premiumMismatch ? 'bg-red-50/60' : ''}>
                      <td className="py-2 font-mono text-xs">{row.householdMemberId}</td>
                      <td className="py-2">{row.primaryName}</td>
                      <td className="py-2 font-mono text-xs">{row.tier || 'EE'}</td>
                      <td className="py-2">{row.dependentCount}</td>
                      <td className="py-2 align-top">
                        <div className="text-xs text-gray-500">{row.productCount} E123 product{row.productCount === 1 ? '' : 's'}</div>
                        {renderPreviewProductBreakdown(row.premiumBreakdown, {
                          emphasizeMismatch: !!row.premiumMismatch
                        })}
                      </td>
                      <td className="py-2 text-xs">
                        {row.ab365AgentCrossTenant ? (
                          <span className="text-red-800">
                            <span className="font-medium block">Wrong tenant</span>
                            {row.ab365AgentName || 'Mapped agent is in another tenant'}
                          </span>
                        ) : row.ab365AgentName ? (
                          <span className="text-gray-800">{row.ab365AgentName}</span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="py-2 text-xs align-top">
                        {row.e123PremiumTotal != null && row.ab365PremiumTotal != null ? (
                          row.premiumMismatch ? (
                            <span className="text-red-800">
                              <span className="font-semibold block">Mismatch</span>
                              E123 ${row.e123PremiumTotal.toFixed(2)} · AB365 ${row.ab365PremiumTotal.toFixed(2)}
                            </span>
                          ) : (
                            <span className="text-green-700">
                              <span className="font-medium block">${row.e123PremiumTotal.toFixed(2)} match</span>
                              {row.premiumOffsetApplied && row.premiumOffsetAdjustment != null && row.premiumOffsetAdjustment !== 0 && (
                                <span className="text-violet-700 block mt-0.5">
                                  Fee offset {formatPremiumOffsetAdjustment(row.premiumOffsetAdjustment)}
                                </span>
                              )}
                            </span>
                          )
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="py-2">
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                          row.action === 'create' ? 'bg-green-100 text-green-800'
                            : row.action === 'update' ? 'bg-violet-100 text-violet-800'
                              : row.action === 'imported' ? 'bg-violet-50 text-violet-800'
                                : row.action === 'skipped' ? 'bg-gray-100 text-gray-800'
                                  : row.action === 'locked' ? 'bg-amber-100 text-amber-900'
                                    : row.action === 'skip' ? 'bg-gray-100 text-gray-800'
                                      : row.action === 'error' ? 'bg-red-100 text-red-800'
                                        : 'bg-red-100 text-red-800'
                        }`}>
                          {row.action === 'update' ? 'pending migration'
                            : row.action === 'imported' ? 'already imported'
                              : row.action === 'locked' ? 'active — skip'
                                : row.action === 'skipped' ? 'skipped'
                                  : row.action}
                        </span>
                        <div className={`text-xs mt-1 ${row.action === 'error' ? 'text-red-700 font-medium' : 'text-gray-400'}`}>
                          {row.message}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {previewTotal > PREVIEW_PAGE_SIZE && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={previewPage <= 1}
                  onClick={() => setPreviewPage((p) => p - 1)}
                  className="px-3 py-1 border rounded-lg text-sm disabled:opacity-50"
                >
                  Prev
                </button>
                <span className="text-sm text-gray-500 inline-flex items-center gap-2">
                  Page {previewPage} of {Math.ceil(previewTotal / PREVIEW_PAGE_SIZE)}
                  {previewLoading ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {previewPageRowCount > 0
                        ? `(${previewRows.length}/${previewPageRowCount})`
                        : null}
                    </>
                  ) : null}
                </span>
                <button
                  type="button"
                  disabled={previewPage * PREVIEW_PAGE_SIZE >= previewTotal || previewLoading}
                  onClick={() => setPreviewPage((p) => p + 1)}
                  className="px-3 py-1 border rounded-lg text-sm disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {footer}

      {applyResultModalOpen && applyResult && (() => {
        const content = buildApplyResultModalContent(applyResult);
        if (!content) return null;
        const iconClass = content.variant === 'success'
          ? 'text-green-600'
          : content.variant === 'warning'
            ? 'text-amber-600'
            : 'text-blue-600';
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setApplyResultModalOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="apply-result-modal-title"
              className="bg-white rounded-xl shadow-xl max-w-md w-full p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start gap-3">
                <CheckCircle className={`h-6 w-6 shrink-0 mt-0.5 ${iconClass}`} />
                <div className="min-w-0 flex-1">
                  <h3 id="apply-result-modal-title" className="text-lg font-semibold text-gray-900">
                    {content.title}
                  </h3>
                  <ul className="mt-3 space-y-1.5 text-sm text-gray-700">
                    {content.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  {content.householdNames?.length ? (
                    <ul className="mt-3 max-h-32 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 space-y-0.5">
                      {content.householdNames.map((name) => (
                        <li key={name}>{name}</li>
                      ))}
                    </ul>
                  ) : null}
                  {content.errorNote ? (
                    <p className="mt-3 text-sm text-amber-800">{content.errorNote}</p>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setApplyResultModalOpen(false)}
                className="mt-6 w-full px-4 py-2 rounded-lg bg-oe-primary text-white font-medium hover:opacity-90"
              >
                OK
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
