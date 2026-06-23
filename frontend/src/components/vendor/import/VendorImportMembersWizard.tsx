import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle, Download, FileUp, Loader2 } from 'lucide-react';
import { apiService } from '../../../services/api.service';
import { API_CONFIG } from '../../../config/api';
import SearchableDropdown from '../../common/SearchableDropdown';
import VendorImportProductMappingStep from './VendorImportProductMappingStep';
import VendorImportProgressPanel from './VendorImportProgressPanel';
import {
  collectDistinctUnmappedPlanKeys,
  formatImportErrorMessage,
  householdHasUnmappedPlans,
  needsFormatChoice,
  sortHouseholdPreviews,
  isMissingDependentsHousehold,
  sortPlanPreviewsForDisplay,
} from './importDisplay';
import {
  coverageTierCellDisplay,
  formatPlanLineDisplay,
  householdChangeChips,
  householdSkipReasonDisplay,
  planLineTextClass,
  planToneClass,
} from './importPreviewDisplay';
import { runVendorImportJob, type VendorImportProgressEvent } from '../../../utils/vendorImportStream';

interface TenantOption {
  tenantId: string;
  tenantName: string;
  tenantStatus?: string;
}

interface FormatPreset {
  slug: string;
  label: string;
  template?: string;
  importRules?: import('../../../types/vendor/vendorImportRules.types').VendorImportRules;
  tobaccoCsvColumn?: string;
  tobaccoYesValues?: string[];
}

interface AgentOption {
  agentId: string;
  label: string;
  agentCode?: string | null;
  email?: string | null;
}

interface FormatSuggestion {
  suggestedSlug: string | null;
  suggestedLabel: string | null;
  suggestedScore: number;
  selectedSlug: string | null;
  selectedLabel: string | null;
  selectedScore: number;
  matchesSelected: boolean;
  confidence: 'low' | 'medium' | 'high';
  autoApply: boolean;
  message: string | null;
  ranked?: Array<{
    slug: string;
    label: string;
    score: number;
    matched?: number;
    expected?: number;
  }>;
}

interface ImportValidation {
  unmappedProducts: string[];
  weakPlanCodes: Array<{ planKey: string; reason: string; suggestion?: string | null }>;
  rowsMissingPlanCode: number;
  rowsWithGenericPlanNameOnly: number;
  formatIssues: Array<{
    code: string;
    message: string;
    suggestedSlug?: string;
    suggestedLabel?: string;
  }>;
  formatSuggestion?: FormatSuggestion;
  mappedProductCount: number;
  totalDistinctProducts: number;
  hasBlockingIssues: boolean;
  summary: string;
}

interface MemberFieldChangePreview {
  field: string;
  from: string;
  to: string;
  who?: string;
}

interface PlanPreview {
  planKey: string;
  productName?: string | null;
  mappedTierLabel?: string | null;
  resolvedMapKey?: string | null;
  currentMappedTierLabel?: string | null;
  memberLabel: string;
  action: string;
  terminateDate?: string | null;
  effectiveDate?: string | null;
  replacementTerminateDate?: string | null;
}

interface DependentPreview {
  name: string;
  relationship: string;
  action: 'create' | 'update';
}

interface EmailIssuePreview {
  role: 'primary' | 'dependent';
  name: string;
  relationship?: string | null;
  reason: string;
  value: string;
  message: string;
}

interface HouseholdPreview {
  householdKey: string;
  action: string;
  skipReason?: string | null;
  importBlockedByEmail?: boolean;
  emailIssues?: EmailIssuePreview[];
  allPlansTerminated?: boolean;
  primaryName: string;
  householdMemberId: string;
  existingAgentId?: string | null;
  coverageTier?: string;
  coverageTierLabel?: string;
  dependentCount: number;
  newDependentCount: number;
  updatedDependentCount: number;
  dependents: DependentPreview[];
  plans: PlanPreview[];
  planTerminations: number;
  planCreates: number;
  planReplaces?: number;
  planUpdates: number;
  memberFieldChanges?: MemberFieldChangePreview[];
  hasTerminationsInFile?: boolean;
  plansWithTermDateInFile?: number;
  unmappedProducts: string[];
  catalogMatchSummary?: string;
  selectedByDefault: boolean;
  missingDependents?: boolean;
  requiredCoverageTier?: string | null;
  requiredCoverageTierLabel?: string | null;
  missingDependentsDetail?: string | null;
}

interface Props {
  vendorId: string;
}

type MemberPreview = {
  statistics: {
    totalRows: number;
    households: number;
    creates: number;
    updates: number;
    terminates: number;
    tenantMoves: number;
    skips: number;
    planTerminations: number;
    planTerminationsPending?: number;
    planTerminationsInFile?: number;
    householdsWithTerminations?: number;
    rowsWithTerminateDate?: number;
    newDependents: number;
    selectedByDefault: number;
    householdsWithInvalidEmail?: number;
    primaryBadEmailSkipped?: number;
    householdsBlockedByEmail?: number;
    unmappedPlanCodes?: number;
    weakPlanCodes?: number;
    rowsWithGenericPlanNameOnly?: number;
    householdsWithUnmappedPlans?: number;
    planReplaces?: number;
    householdsWithPlanReplaces?: number;
    householdsWithMemberFieldChanges?: number;
    householdsMissingDependents?: number;
  };
  validation?: ImportValidation;
  distinctProducts: string[];
  planCodeGroups?: Array<{ lookupKey: string; filePlanCodes: string[] }>;
  households: HouseholdPreview[];
};

type ImportResult = {
  created: number;
  updated: number;
  moved: number;
  enrollments: number;
  enrollmentHouseholds?: number;
  terminated: number;
  terminatedHouseholds?: number;
  skipped: number;
  errors: Array<{ household?: string; message: string }>;
};

function formatPlanCountAcrossHouseholds(
  planCount: number,
  householdCount: number | undefined,
  verb: 'enrolled' | 'terminated',
): string {
  const planLabel = `${planCount} plan${planCount === 1 ? '' : 's'} ${verb}`;
  if (householdCount == null || householdCount <= 0) return `${planLabel}. `;
  const hhLabel = `${householdCount} household${householdCount === 1 ? '' : 's'}`;
  return `${planLabel} across ${hhLabel}. `;
}

function actionRowClass(
  action: string,
  allPlansTerminated?: boolean,
  importBlockedByEmail?: boolean,
  missingDependents?: boolean,
): string {
  if (missingDependents) return 'bg-fuchsia-50 text-fuchsia-950';
  if (importBlockedByEmail) return 'bg-orange-50 text-orange-950';
  if (action === 'skip' || allPlansTerminated) return 'bg-gray-100 text-gray-600';
  if (action === 'create') return 'bg-green-50';
  if (action === 'terminate') return 'bg-red-50';
  if (action === 'move_tenant') return 'bg-amber-50';
  return 'bg-blue-50';
}

function actionBadgeClass(action: string, importBlockedByEmail?: boolean, missingDependents?: boolean): string {
  if (missingDependents) return 'bg-fuchsia-200 text-fuchsia-950';
  if (importBlockedByEmail) return 'bg-orange-200 text-orange-950';
  if (action === 'skip') return 'bg-gray-200 text-gray-800';
  if (action === 'create') return 'bg-green-200 text-green-900';
  if (action === 'terminate') return 'bg-red-200 text-red-900';
  if (action === 'move_tenant') return 'bg-amber-200 text-amber-900';
  return 'bg-blue-200 text-blue-900';
}

function memberFieldLabel(field: string): string {
  if (field === 'TobaccoUse') return 'Tobacco';
  if (field === 'Tier') return 'Coverage tier';
  return field;
}

function tenantStatusLabel(status?: string): string | null {
  if (!status || status === 'Active') return null;
  if (status === 'Inactive') return 'Inactive';
  return status;
}

function tenantDisplayName(t: TenantOption): string {
  const tag = tenantStatusLabel(t.tenantStatus);
  return tag ? `${t.tenantName} (${tag})` : t.tenantName;
}

function actionDisplayLabel(h: HouseholdPreview): string {
  const skip = householdSkipReasonDisplay(h);
  if (skip) return skip.badge;
  if (h.action === 'move_tenant') return 'Move tenant';
  return h.action;
}

const VendorImportMembersWizard: React.FC<Props> = ({ vendorId: _vendorId }) => {
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [presets, setPresets] = useState<FormatPreset[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [formatSlug, setFormatSlug] = useState('sharewell_default');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<MemberPreview | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [importTerminatedHistory, setImportTerminatedHistory] = useState(false);
  const [importAsPendingMigration, setImportAsPendingMigration] = useState(false);
  const [resetMemberAccounts, setResetMemberAccounts] = useState(false);
  const [allowTenantMove, setAllowTenantMove] = useState(false);
  const [householdAgentByKey, setHouseholdAgentByKey] = useState<Record<string, string>>({});
  const [agentOptions, setAgentOptions] = useState<AgentOption[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [step, setStep] = useState<'upload' | 'products' | 'preview' | 'done'>('upload');
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('Analyzing file');
  const [progress, setProgress] = useState<VendorImportProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const [fileInputKey, setFileInputKey] = useState(0);
  const [tobaccoCsvColumn, setTobaccoCsvColumn] = useState('');
  const [tobaccoYesValues, setTobaccoYesValues] = useState<string[]>([]);
  const [formatSuggestion, setFormatSuggestion] = useState<FormatSuggestion | null>(null);
  const [formatDetecting, setFormatDetecting] = useState(false);
  const [formatModalOpen, setFormatModalOpen] = useState(false);
  const [pendingUploadFile, setPendingUploadFile] = useState<File | null>(null);
  const [formatChoiceSlug, setFormatChoiceSlug] = useState('');

  useEffect(() => {
    if (!tenantId) {
      setAgentOptions([]);
      setHouseholdAgentByKey({});
      return;
    }
    setAgentsLoading(true);
    void apiService.get<{ success: boolean; data: AgentOption[] }>(
      `/api/me/vendor/import/agents?tenantId=${encodeURIComponent(tenantId)}`
    )
      .then((r) => {
        if (r.success) setAgentOptions(r.data || []);
      })
      .catch(() => setAgentOptions([]))
      .finally(() => setAgentsLoading(false));
  }, [tenantId]);

  const agentDropdownOptions = useMemo(
    () => agentOptions.map((a) => ({
      id: a.agentId,
      value: a.agentId,
      label: a.label,
      email: a.email || undefined,
      code: a.agentCode || undefined,
    })),
    [agentOptions]
  );

  const setHouseholdAgent = (householdKey: string, agentId: string) => {
    setHouseholdAgentByKey((prev) => {
      const next = { ...prev };
      if (agentId) next[householdKey] = agentId;
      else delete next[householdKey];
      return next;
    });
  };

  const initHouseholdAgents = (data: MemberPreview) => {
    const initial: Record<string, string> = {};
    for (const h of data.households) {
      if (h.existingAgentId) initial[h.householdKey] = h.existingAgentId;
    }
    setHouseholdAgentByKey(initial);
  };
  const selectedTenant = tenants.find((t) => t.tenantId === tenantId);
  const selectedTenantInactive = selectedTenant?.tenantStatus === 'Inactive';
  const selectedFormatPreset = presets.find((p) => p.slug === formatSlug);

  useEffect(() => {
    if (!selectedFormatPreset) return;
    setTobaccoCsvColumn(selectedFormatPreset.tobaccoCsvColumn || 'Tobacco Surcharge');
    setTobaccoYesValues(selectedFormatPreset.tobaccoYesValues || []);
  }, [selectedFormatPreset?.slug, selectedFormatPreset?.tobaccoCsvColumn, selectedFormatPreset?.tobaccoYesValues]);

  useEffect(() => {
    void apiService.get<{ success: boolean; data: TenantOption[] }>('/api/me/vendor/import/tenants')
      .then((r) => { if (r.success) setTenants(r.data || []); })
      .catch(() => setError('Failed to load tenants'));
    void apiService.get<{ success: boolean; data: FormatPreset[] }>('/api/me/vendor/import/format-presets')
      .then((r) => { if (r.success && r.data?.length) setPresets(r.data); })
      .catch(() => setPresets([{ slug: 'sharewell_default', label: 'ShareWELL Standard (24-col)' }]));
    void apiService.get<{ success: boolean; data: { defaultEligibilityFormatSlug?: string } }>(
      '/api/me/vendor/import/eligibility-format'
    )
      .then((r) => {
        if (r.success && r.data?.defaultEligibilityFormatSlug) {
          setFormatSlug(r.data.defaultEligibilityFormatSlug);
        }
      })
      .catch(() => {});
  }, []);

  const initSelection = (data: MemberPreview, includeTerminatedHistory: boolean) => {
    const keys = new Set<string>();
    for (const h of data.households) {
      if (h.action === 'move_tenant') continue;
      if (h.selectedByDefault || (includeTerminatedHistory && h.allPlansTerminated)) {
        keys.add(h.householdKey);
      }
    }
    setSelectedKeys(keys);
  };

  const downloadSample = async () => {
    const token = localStorage.getItem('accessToken') || localStorage.getItem('token');
    const base = API_CONFIG.BASE_URL;
    const res = await fetch(`${base}/api/me/vendor/import/eligibility-sample`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'eligibility-sample.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const detectFileFormat = async (uploadedFile: File, slugForDetect: string) => {
    setFormatDetecting(true);
    try {
      const form = new FormData();
      form.append('file', uploadedFile);
      form.append('formatSlug', slugForDetect);
      const res = await apiService.post<{ success: boolean; data: FormatSuggestion }>(
        '/api/me/vendor/import/members/detect-format',
        form,
      );
      if (res.success && res.data) {
        setFormatSuggestion(res.data);
        return res.data;
      }
      setFormatSuggestion(null);
      return null;
    } catch {
      setFormatSuggestion(null);
      return null;
    } finally {
      setFormatDetecting(false);
    }
  };

  const openFormatChoiceModal = (suggestion: FormatSuggestion, uploadFile: File) => {
    setPendingUploadFile(uploadFile);
    setFile(uploadFile);
    setFormatSuggestion(suggestion);
    setFormatChoiceSlug(suggestion.suggestedSlug || formatSlug);
    setFormatModalOpen(true);
    setPreview(null);
    setStep('upload');
    setLoading(false);
    setProgress(null);
  };

  const cancelFormatChoice = () => {
    setFormatModalOpen(false);
    setFormatSuggestion(null);
    setPendingUploadFile(null);
    setFile(null);
    setPreview(null);
    setFileInputKey((k) => k + 1);
  };

  const confirmFormatChoiceAndPreview = async (slug: string) => {
    const uploadFile = pendingUploadFile ?? file;
    if (!uploadFile || !tenantId || !slug) return;
    setFormatModalOpen(false);
    setFormatSuggestion(null);
    setFormatSlug(slug);
    setPendingUploadFile(null);
    await runPreview(uploadFile, slug, { skipFormatGate: true });
  };

  const runPreview = async (
    uploadedFile?: File | null,
    formatSlugOverride?: string,
    options?: { skipFormatGate?: boolean },
  ) => {
    const fileToUse = uploadedFile ?? file;
    if (!tenantId || !fileToUse) return;
    const slugToUse = formatSlugOverride ?? formatSlug;
    setFile(fileToUse);
    setLoading(true);
    setLoadingLabel('Analyzing file');
    setProgress({ message: 'Uploading CSV…' });
    setError(null);
    try {
      const form = new FormData();
      form.append('tenantId', tenantId);
      form.append('formatSlug', slugToUse);
      form.append('file', fileToUse);
      const res = await runVendorImportJob<MemberPreview>(
        '/api/me/vendor/import/members/parse',
        form,
        setProgress
      );
      const parseSuggestion = res.data.validation?.formatSuggestion;
      if (!options?.skipFormatGate && needsFormatChoice(parseSuggestion)) {
        openFormatChoiceModal(parseSuggestion!, fileToUse);
        return;
      }
      setPreview(res.data);
      setFormatSuggestion(null);
      initSelection(res.data, importTerminatedHistory);
      initHouseholdAgents(res.data);
      setStep(res.data.distinctProducts?.length ? 'products' : 'preview');
      setProgress(null);
    } catch (e: unknown) {
      setError(formatImportErrorMessage(e, 'Preview failed'));
    } finally {
      setLoading(false);
    }
  };

  const selectedCount = selectedKeys.size;

  const selectableHouseholds = useMemo(
    () => (preview?.households ?? []).filter((h) => !h.importBlockedByEmail && !isMissingDependentsHousehold(h)),
    [preview],
  );

  const allSelectableSelected = selectableHouseholds.length > 0
    && selectableHouseholds.every((h) => selectedKeys.has(h.householdKey));

  const someSelectableSelected = selectableHouseholds.some((h) => selectedKeys.has(h.householdKey));

  const toggleHousehold = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => {
    if (!preview) return;
    setSelectedKeys(new Set(
      preview.households
        .filter((h) => !h.importBlockedByEmail && !isMissingDependentsHousehold(h))
        .map((h) => h.householdKey)
    ));
  };

  const deselectAll = () => setSelectedKeys(new Set());

  const selectNonTerminated = () => {
    if (!preview) return;
    setImportTerminatedHistory(false);
    setSelectedKeys(new Set(
      preview.households
        .filter((h) => !h.allPlansTerminated && h.action !== 'skip' && h.action !== 'move_tenant' && !h.importBlockedByEmail && !isMissingDependentsHousehold(h))
        .map((h) => h.householdKey)
    ));
  };

  const selectTenantMoves = () => {
    if (!preview) return;
    setAllowTenantMove(true);
    setSelectedKeys(new Set(
      preview.households
        .filter((h) => h.action === 'move_tenant' && !h.importBlockedByEmail)
        .map((h) => h.householdKey),
    ));
  };

  const selectTerminatedOnly = () => {
    if (!preview) return;
    setImportTerminatedHistory(true);
    setSelectedKeys(new Set(
      preview.households
        .filter((h) => h.allPlansTerminated && !h.importBlockedByEmail)
        .map((h) => h.householdKey)
    ));
  };

  const commit = async () => {
    if (!tenantId || !file || selectedCount === 0) return;
    setLoading(true);
    setLoadingLabel('Importing');
    setProgress({ message: 'Starting import…' });
    setError(null);
    try {
      const form = new FormData();
      form.append('tenantId', tenantId);
      form.append('formatSlug', formatSlug);
      form.append('file', file);
      form.append('isPendingMigration', importAsPendingMigration ? 'true' : 'false');
      form.append('resetMemberAccounts', resetMemberAccounts ? 'true' : 'false');
      form.append('allowTenantMove', allowTenantMove ? 'true' : 'false');
      form.append('importTerminatedOnlyForHistory', importTerminatedHistory ? 'true' : 'false');
      form.append('importFileName', file.name);
      const agentMap = Object.fromEntries(
        [...selectedKeys]
          .filter((key) => householdAgentByKey[key])
          .map((key) => [key, householdAgentByKey[key]])
      );
      if (Object.keys(agentMap).length) {
        form.append('householdAgentMap', JSON.stringify(agentMap));
      }
      form.append('selectedHouseholdKeys', JSON.stringify([...selectedKeys]));
      const res = await runVendorImportJob<ImportResult>(
        '/api/me/vendor/import/members/commit',
        form,
        setProgress
      );
      setResult(res.data);
      setStep('done');
      setProgress(null);
    } catch (e: unknown) {
      setError(formatImportErrorMessage(e, 'Import failed'));
    } finally {
      setLoading(false);
    }
  };

  const sortedHouseholds = useMemo(() => {
    if (!preview?.households) return [];
    return sortHouseholdPreviews(preview.households);
  }, [preview]);

  const distinctUnmappedPlanKeys = useMemo(() => {
    if (!preview?.households) return [];
    return collectDistinctUnmappedPlanKeys(preview.households);
  }, [preview]);

  const unmappedHouseholdCount = useMemo(
    () => sortedHouseholds.filter((h) => householdHasUnmappedPlans(h)).length,
    [sortedHouseholds],
  );

  const missingDependentsHouseholdCount = useMemo(
    () => sortedHouseholds.filter((h) => isMissingDependentsHousehold(h)).length,
    [sortedHouseholds],
  );

  const tenantMoveCount = preview?.statistics.tenantMoves ?? 0;

  useEffect(() => {
    if (!preview) return;
    const anyMoveSelected = preview.households.some(
      (h) => h.action === 'move_tenant' && selectedKeys.has(h.householdKey),
    );
    if (anyMoveSelected) setAllowTenantMove(true);
  }, [selectedKeys, preview]);

  const importSuccessCount = result
    ? result.created + result.updated + result.moved + result.enrollments + result.terminated
    : 0;

  const showHouseholdList = Boolean(preview && (step === 'preview' || step === 'done'));
  const previewReadOnly = step === 'done';

  const formatModalSuggestion = formatModalOpen ? formatSuggestion : null;

  const handleFilePicked = async (picked: File) => {
    if (!tenantId) {
      setError('Select a tenant before uploading.');
      setFileInputKey((k) => k + 1);
      return;
    }
    setError(null);
    setPreview(null);
    setStep('upload');
    const detected = await detectFileFormat(picked, formatSlug);
    if (detected && needsFormatChoice(detected)) {
      openFormatChoiceModal(detected, picked);
      return;
    }
    await runPreview(picked, formatSlug);
  };

  return (
    <div className="space-y-4">
      {error && (
        <div
          className="sticky top-0 z-20 flex items-start gap-3 p-4 bg-red-50 border-2 border-red-300 rounded-lg text-sm text-red-900 shadow-sm"
          role="alert"
        >
          <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Import error</p>
            <p className="mt-1 whitespace-pre-wrap break-words">{formatImportErrorMessage(error)}</p>
          </div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="shrink-0 text-xs font-medium text-red-800 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-3 items-end">
        <div className="min-w-[220px]">
          <label className="block text-sm font-medium text-gray-700 mb-1">Tenant</label>
          <select
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
          >
            <option value="">Select tenant…</option>
            {tenants.map((t) => (
              <option key={t.tenantId} value={t.tenantId}>{tenantDisplayName(t)}</option>
            ))}
          </select>
          {selectedTenantInactive && (
            <p className="mt-1 text-xs text-amber-700">
              This tenant is inactive. Imports may still run, but the tenant is deactivated in AB365.
            </p>
          )}
        </div>
        <div className="min-w-[220px]">
          <label className="block text-sm font-medium text-gray-700 mb-1">File format</label>
          <select
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            value={formatSlug}
            onChange={(e) => {
              setFormatSlug(e.target.value);
              setFormatSuggestion(null);
            }}
          >
            {presets.map((p) => (
              <option key={p.slug} value={p.slug}>{p.label}</option>
            ))}
          </select>
        </div>
        <button type="button" onClick={() => void downloadSample()} className="inline-flex items-center gap-2 px-3 py-2 text-sm border rounded-lg hover:bg-gray-50">
          <Download className="h-4 w-4" /> Example eligibility file
        </button>
      </div>

      {formatModalOpen && formatModalSuggestion && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="format-choice-title"
        >
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <div className="p-5 border-b border-gray-200">
              <h2 id="format-choice-title" className="text-lg font-semibold text-gray-900">
                Choose file format
              </h2>
              <p className="mt-2 text-sm text-gray-700">
                {formatModalSuggestion.message || 'This CSV may not match the format you selected.'}
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Preview and import are paused until you confirm. Switching format mid-upload causes bad mappings.
              </p>
            </div>
            <div className="p-5 space-y-3">
              {formatModalSuggestion.suggestedSlug && (
                <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer ${
                  formatChoiceSlug === formatModalSuggestion.suggestedSlug
                    ? 'border-amber-500 bg-amber-50'
                    : 'border-gray-200 hover:bg-gray-50'
                }`}>
                  <input
                    type="radio"
                    name="formatChoice"
                    className="mt-1"
                    checked={formatChoiceSlug === formatModalSuggestion.suggestedSlug}
                    onChange={() => setFormatChoiceSlug(formatModalSuggestion.suggestedSlug!)}
                  />
                  <div>
                    <div className="font-medium text-gray-900">
                      {formatModalSuggestion.suggestedLabel || formatModalSuggestion.suggestedSlug}
                      <span className="ml-2 text-xs font-normal text-amber-800">Recommended</span>
                    </div>
                    <div className="text-xs text-gray-600 mt-0.5">
                      {Math.round(formatModalSuggestion.suggestedScore * 100)}% header match
                    </div>
                  </div>
                </label>
              )}
              {formatModalSuggestion.selectedSlug && (
                <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer ${
                  formatChoiceSlug === formatModalSuggestion.selectedSlug
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:bg-gray-50'
                }`}>
                  <input
                    type="radio"
                    name="formatChoice"
                    className="mt-1"
                    checked={formatChoiceSlug === formatModalSuggestion.selectedSlug}
                    onChange={() => setFormatChoiceSlug(formatModalSuggestion.selectedSlug!)}
                  />
                  <div>
                    <div className="font-medium text-gray-900">
                      {formatModalSuggestion.selectedLabel || formatModalSuggestion.selectedSlug}
                      <span className="ml-2 text-xs font-normal text-gray-600">Currently selected</span>
                    </div>
                    <div className="text-xs text-gray-600 mt-0.5">
                      {Math.round(formatModalSuggestion.selectedScore * 100)}% header match
                    </div>
                  </div>
                </label>
              )}
              {(formatModalSuggestion.ranked || [])
                .filter((r) => r.slug !== formatModalSuggestion.suggestedSlug
                  && r.slug !== formatModalSuggestion.selectedSlug)
                .slice(0, 3)
                .map((r) => (
                  <label
                    key={r.slug}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer ${
                      formatChoiceSlug === r.slug
                        ? 'border-gray-400 bg-gray-50'
                        : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="formatChoice"
                      className="mt-1"
                      checked={formatChoiceSlug === r.slug}
                      onChange={() => setFormatChoiceSlug(r.slug)}
                    />
                    <div>
                      <div className="font-medium text-gray-900">{r.label}</div>
                      <div className="text-xs text-gray-600 mt-0.5">
                        {Math.round(r.score * 100)}% header match
                      </div>
                    </div>
                  </label>
                ))}
            </div>
            <div className="p-5 border-t border-gray-200 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
                onClick={cancelFormatChoice}
              >
                Cancel upload
              </button>
              <button
                type="button"
                className="px-4 py-2 text-sm font-medium rounded-lg bg-oe-primary text-white hover:bg-oe-primary-dark"
                onClick={() => void confirmFormatChoiceAndPreview(formatChoiceSlug)}
                disabled={!formatChoiceSlug}
              >
                Continue with selected format
              </button>
            </div>
          </div>
        </div>
      )}

      {loading && progress && !formatModalOpen && (
        <VendorImportProgressPanel progress={progress} title={loadingLabel} />
      )}

      {step === 'upload' && (
        <div className="border border-dashed border-gray-300 rounded-lg p-6">
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <input
              key={fileInputKey}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              id="elig-import-file"
              onChange={(e) => {
                const picked = e.target.files?.[0] || null;
                if (!picked) return;
                void handleFilePicked(picked);
              }}
            />
            <button
              type="button"
              disabled={!tenantId || loading || formatModalOpen}
              onClick={() => document.getElementById('elig-import-file')?.click()}
              className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium border-2 transition-colors ${
                !tenantId || loading
                  ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                  : 'border-oe-primary bg-oe-primary text-white hover:bg-oe-primary-dark cursor-pointer shadow-sm'
              }`}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileUp className="h-4 w-4" />
              )}
              Upload Eligibility File
            </button>
            {file && (
              <span className="text-sm text-gray-600 truncate max-w-xs" title={file.name}>
                {file.name}
              </span>
            )}
          </div>
          {!tenantId && (
            <p className="text-center text-xs text-gray-500 mt-3">Select a tenant first, then upload a CSV to preview.</p>
          )}
          {tenantId && !loading && !file && (
            <p className="text-center text-xs text-gray-500 mt-3">
              Uploading checks the file format first. If it does not match your preset, you will choose the format before preview.
            </p>
          )}
          {formatDetecting && (
            <p className="text-center text-xs text-gray-500 mt-2">Checking CSV columns…</p>
          )}
        </div>
      )}

      {step === 'products' && preview && (
        <VendorImportProductMappingStep
          formatSlug={selectedFormatPreset?.slug}
          distinctProducts={preview.distinctProducts}
          planCodeGroups={preview.planCodeGroups}
          importRules={selectedFormatPreset?.importRules}
          formatLabel={selectedFormatPreset?.label}
          rowTemplate={selectedFormatPreset?.template}
          tobaccoCsvColumn={tobaccoCsvColumn}
          tobaccoYesValues={tobaccoYesValues}
          onTobaccoChange={({ tobaccoCsvColumn: col, tobaccoYesValues: yes }) => {
            setTobaccoCsvColumn(col);
            setTobaccoYesValues(yes);
          }}
          validation={preview.validation}
          onBack={() => setStep('upload')}
          onContinue={async () => {
            if (selectedFormatPreset?.slug) {
              try {
                await apiService.put(
                  `/api/me/vendor/import/format-presets/${encodeURIComponent(selectedFormatPreset.slug)}`,
                  { tobaccoCsvColumn, tobaccoYesValues },
                );
              } catch {
                /* non-blocking — import still uses in-memory values this session */
              }
            }
            setStep('preview');
          }}
        />
      )}

      {showHouseholdList && preview && (
        <div className="space-y-3">
          {step === 'done' && result && (
            <div className={`rounded-lg border p-4 text-sm ${
              importSuccessCount > 0 && result.errors.length === 0
                ? 'bg-green-50 border-green-200'
                : importSuccessCount > 0
                  ? 'bg-amber-50 border-amber-200'
                  : 'bg-red-50 border-red-200'
            }`}>
              <div className="flex items-start gap-2">
                <CheckCircle className={`h-5 w-5 shrink-0 ${
                  importSuccessCount > 0 && result.errors.length === 0
                    ? 'text-green-600'
                    : importSuccessCount > 0
                      ? 'text-amber-600'
                      : 'text-red-600'
                }`} />
                <div className="flex-1 space-y-3">
                  <div>
                    <p className="font-medium text-gray-900">
                      {importSuccessCount > 0 && result.errors.length === 0
                        ? 'Import complete'
                        : importSuccessCount > 0
                          ? 'Import partially complete'
                          : 'Import failed'}
                    </p>
                    <p className="mt-1 text-gray-700">
                      {result.created > 0 && <span>{result.created} household{result.created === 1 ? '' : 's'} created. </span>}
                      {result.updated > 0 && <span>{result.updated} updated household{result.updated === 1 ? '' : 's'}. </span>}
                      {result.moved > 0 && <span>{result.moved} household{result.moved === 1 ? '' : 's'} moved to tenant. </span>}
                      {result.enrollments > 0 && (
                        <span>
                          {formatPlanCountAcrossHouseholds(
                            result.enrollments,
                            result.enrollmentHouseholds,
                            'enrolled',
                          )}
                        </span>
                      )}
                      {result.terminated > 0 && (
                        <span>
                          {formatPlanCountAcrossHouseholds(
                            result.terminated,
                            result.terminatedHouseholds,
                            'terminated',
                          )}
                        </span>
                      )}
                      {result.skipped > 0 && <span>{result.skipped} skipped. </span>}
                      {result.errors.length > 0 && <span>{result.errors.length} household{result.errors.length === 1 ? '' : 's'} failed.</span>}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
                    {[
                      ['Households created', result.created, null],
                      ['Households updated', result.updated, null],
                      ['Households moved', result.moved, null],
                      [
                        'Plans enrolled',
                        result.enrollments,
                        result.enrollmentHouseholds != null && result.enrollmentHouseholds > 0
                          ? `across ${result.enrollmentHouseholds} household${result.enrollmentHouseholds === 1 ? '' : 's'}`
                          : null,
                      ],
                      [
                        'Plans terminated',
                        result.terminated,
                        result.terminatedHouseholds != null && result.terminatedHouseholds > 0
                          ? `across ${result.terminatedHouseholds} household${result.terminatedHouseholds === 1 ? '' : 's'}`
                          : null,
                      ],
                      ['Households skipped', result.skipped, null],
                    ].map(([label, value, sublabel]) => (
                      <div key={String(label)} className="bg-white/70 rounded-lg p-2 text-center border border-gray-200/80">
                        <div className="text-lg font-semibold text-gray-900">{value}</div>
                        <div className="text-xs text-gray-600">{label}</div>
                        {sublabel ? <div className="text-[10px] text-gray-500 mt-0.5">{sublabel}</div> : null}
                      </div>
                    ))}
                  </div>

                  {result.errors.length > 0 && (
                    <div className="rounded-lg border-2 border-red-300 bg-red-50 p-4">
                      <p className="font-semibold text-red-900 mb-2">
                        {result.errors.length} household{result.errors.length !== 1 ? 's' : ''} failed
                      </p>
                      <ul className="space-y-2 text-sm text-red-900 max-h-[min(40vh,320px)] overflow-auto">
                        {result.errors.map((err, i) => (
                          <li key={i} className="border-b border-red-200/80 pb-2 last:border-0 last:pb-0">
                            {err.household && (
                              <span className="font-medium block">{err.household}</span>
                            )}
                            <span className="whitespace-pre-wrap break-words">
                              {formatImportErrorMessage(err.message)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setStep('upload');
                      setPreview(null);
                      setResult(null);
                      setFile(null);
                      setImportAsPendingMigration(false);
                      setResetMemberAccounts(false);
                      setAllowTenantMove(false);
                      setHouseholdAgentByKey({});
                      setFileInputKey((k) => k + 1);
                    }}
                    className="px-4 py-2 border rounded-lg text-sm bg-white hover:bg-gray-50"
                  >
                    Import another file
                  </button>
                </div>
              </div>
            </div>
          )}

          {previewReadOnly && (
            <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
              Household list from this import run (read-only). Scroll to review who was included.
            </p>
          )}

          {!previewReadOnly && preview.validation?.hasBlockingIssues && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
              <div className="font-medium flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                Plan mapping incomplete
              </div>
              <p className="mt-1">{preview.validation.summary}</p>
              {preview.validation.weakPlanCodes.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs">
                  {preview.validation.weakPlanCodes.map((w) => (
                    <li key={w.planKey}>
                      <span className="font-mono font-medium">{w.planKey}</span>
                      {w.suggestion ? ` — ${w.suggestion}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {preview.validation.rowsWithGenericPlanNameOnly > 0 && (
                <p className="mt-2 text-xs">
                  {preview.validation.rowsWithGenericPlanNameOnly} row(s) use a product name (e.g. Essential) without Plan Tier + UA.
                </p>
              )}
              {(preview.validation.formatIssues?.length ?? 0) > 0 && (
                <ul className="mt-2 space-y-1 text-xs">
                  {preview.validation.formatIssues.map((issue) => (
                    <li key={`${issue.code}-${issue.message}`} className="flex flex-wrap items-center gap-2">
                      <span>{issue.message}</span>
                      {issue.code === 'format_suggestion' && issue.suggestedSlug && file && (
                        <button
                          type="button"
                          className="underline font-medium text-amber-900"
                          onClick={() => {
                            const suggestion = preview?.validation?.formatSuggestion;
                            if (suggestion && needsFormatChoice(suggestion)) {
                              openFormatChoiceModal(suggestion, file);
                            } else {
                              void confirmFormatChoiceAndPreview(issue.suggestedSlug!);
                            }
                          }}
                        >
                          Choose format…
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {!previewReadOnly && preview.validation && !preview.validation.hasBlockingIssues && preview.validation.totalDistinctProducts > 0 && (
            <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-900 flex items-center gap-2">
              <CheckCircle className="h-4 w-4 shrink-0" />
              {preview.validation.summary}
            </div>
          )}
          {missingDependentsHouseholdCount > 0 && (
            <div className="rounded-lg border border-fuchsia-300 bg-fuchsia-50 px-4 py-3 text-sm text-fuchsia-950">
              <div className="font-medium">
                {missingDependentsHouseholdCount} household{missingDependentsHouseholdCount !== 1 ? 's' : ''} with{' '}
                <span className="uppercase tracking-wide">missing dependents</span>
                {' '}(at top of table — not imported)
              </div>
              <p className="mt-1 text-xs text-fuchsia-900">
                Plan code bills ES, EC, or EF (family pricing) but this file has no spouse/child rows for that primary.
                <strong> List-bill (LB) files from ShareWELL only send the subscriber row</strong> — that is normal for LB,
                but import is blocked until you use a full eligibility export (with dependent rows) or add S/C rows to the CSV.
              </p>
            </div>
          )}
          {distinctUnmappedPlanKeys.length > 0 && (
            <div className="rounded-lg border border-orange-300 bg-orange-50 px-4 py-3 text-sm text-orange-950">
              <div className="font-medium">
                {unmappedHouseholdCount} household{unmappedHouseholdCount !== 1 ? 's' : ''} with unmapped plan codes
                {' '}(listed after skipped rows, before other rows)
              </div>
              <p className="mt-1 text-xs text-orange-900">
                Add mappings in the product-mapping step, then re-preview. Until mapped, those households skip enrollment.
              </p>
              <ul className="mt-2 flex flex-wrap gap-2 text-xs font-mono">
                {distinctUnmappedPlanKeys.map((key) => (
                  <li
                    key={key}
                    className="px-2 py-1 rounded bg-white border border-orange-200 text-orange-950"
                  >
                    {key}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-10 gap-2 text-sm">
            <div className="bg-gray-50 p-3 rounded-lg">Rows: {preview.statistics.totalRows}</div>
            <div className="bg-gray-50 p-3 rounded-lg">Households: {preview.statistics.households}</div>
            <div className="bg-green-50 p-3 rounded-lg">New households: {preview.statistics.creates}</div>
            <div className="bg-blue-50 p-3 rounded-lg">Update households: {preview.statistics.updates}</div>
            {(preview.statistics.tenantMoves ?? 0) > 0 && (
              <div className="bg-amber-50 p-3 rounded-lg border border-amber-200">
                Tenant moves: {preview.statistics.tenantMoves}
              </div>
            )}
            <div className="bg-purple-50 p-3 rounded-lg">New deps: {preview.statistics.newDependents}</div>
            {(preview.statistics.planReplaces ?? 0) > 0 && (
              <div className="bg-violet-50 p-3 rounded-lg border border-violet-200">
                Plan tier changes: {preview.statistics.planReplaces}
                {' '}
                <span className="text-violet-800 text-xs">
                  ({preview.statistics.householdsWithPlanReplaces ?? 0} households)
                </span>
              </div>
            )}
            <div className="bg-red-50 p-3 rounded-lg" title="Plan rows in file with a termination date">
              Plans w/ term date: {preview.statistics.planTerminationsInFile ?? preview.statistics.planTerminations}
            </div>
            <div className="bg-red-50/70 p-3 rounded-lg" title="Plans that will terminate an existing active enrollment">
              Plans to terminate: {preview.statistics.planTerminations}
            </div>
            <div className="bg-orange-50 p-3 rounded-lg" title="Termination dates in file for members not yet in AB365">
              Pending terms: {preview.statistics.planTerminationsPending ?? 0}
            </div>
            <div className="bg-red-100/60 p-3 rounded-lg" title="Households with at least one plan row carrying a termination date">
              HH w/ terms: {preview.statistics.householdsWithTerminations ?? 0}
            </div>
            {(preview.statistics.householdsMissingDependents ?? 0) > 0 && (
              <div className="bg-fuchsia-50 p-3 rounded-lg border border-fuchsia-200">
                Missing dependents: {preview.statistics.householdsMissingDependents}
              </div>
            )}
            <div className="bg-gray-100 p-3 rounded-lg">Skip: {preview.statistics.skips}</div>
            {(preview.statistics.primaryBadEmailSkipped ?? preview.statistics.householdsWithInvalidEmail ?? 0) > 0 && (
              <div className="bg-orange-50 p-3 rounded-lg" title="New households skipped because the primary has missing or invalid email">
                Bad email (skipped): {preview.statistics.primaryBadEmailSkipped ?? preview.statistics.householdsWithInvalidEmail}
              </div>
            )}
          </div>
          {(preview.statistics.rowsWithTerminateDate ?? 0) > 0 &&
            (preview.statistics.planTerminationsInFile ?? 0) === 0 && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              File has {preview.statistics.rowsWithTerminateDate} row(s) with termination dates, but none mapped to a product yet.
              Complete product mapping or check the file format.
            </p>
          )}

          {!previewReadOnly && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-4">
            <div className="text-sm font-medium text-gray-800">Import options</div>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={importAsPendingMigration}
                onChange={(e) => setImportAsPendingMigration(e.target.checked)}
              />
              <span>
                <span className="font-medium text-gray-900">Import as pending migration</span>
                <span className="block text-xs text-gray-600 mt-0.5">
                  Sets <code className="bg-gray-100 px-1 rounded">IsPendingMigration</code> on the household (members + enrollments), including re-imports of existing members.
                </span>
              </span>
            </label>
            {tenantMoveCount > 0 && (
              <label className="flex items-start gap-2 text-sm cursor-pointer border border-amber-200 rounded-lg p-3 bg-amber-50/80">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={allowTenantMove}
                  onChange={(e) => setAllowTenantMove(e.target.checked)}
                />
                <span>
                  <span className="font-medium text-amber-950">Allow tenant move</span>
                  <span className="block text-xs text-amber-900 mt-0.5">
                    Required to import households listed as Move tenant (member exists under another tenant).
                  </span>
                </span>
              </label>
            )}
            <label className="flex items-start gap-2 text-sm cursor-pointer border border-red-200 rounded-lg p-3 bg-red-50/50">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={resetMemberAccounts}
                onChange={(e) => setResetMemberAccounts(e.target.checked)}
              />
              <span>
                <span className="font-medium text-red-900">Reset member accounts (dangerous)</span>
                <span className="block text-xs text-red-800 mt-0.5">
                  For selected households that already exist in AB365: terminate all active enrollments for the household, then re-apply plan rows from this file. Use after a bad import left duplicate Essential plans — then re-import with correct product mapping.
                </span>
              </span>
            </label>
            <p className="text-xs text-gray-500">
              Assign an agent per household in the table below. Applies to new and existing imports — sets primary{' '}
              <code className="bg-gray-100 px-1 rounded">AgentId</code> and active enrollment agents for that household.
            </p>
          </div>
          )}

          {!previewReadOnly && (
          <div className="flex flex-wrap gap-2 items-center text-sm">
            <span className="text-gray-600">{selectedCount} household{selectedCount !== 1 ? 's' : ''} selected</span>
            <span className="text-gray-400">·</span>
            <span className="text-gray-500 text-xs">Selection applies to the whole household (primary + dependents)</span>
            <button type="button" onClick={selectAll} className="px-2 py-1 border rounded hover:bg-gray-50">Select all</button>
            <button type="button" onClick={deselectAll} className="px-2 py-1 border rounded hover:bg-gray-50">Deselect all</button>
            <button type="button" onClick={selectNonTerminated} className="px-2 py-1 border rounded hover:bg-gray-50">Non-terminated only</button>
            {tenantMoveCount > 0 && (
              <button
                type="button"
                onClick={selectTenantMoves}
                className="px-2 py-1 border border-amber-300 bg-amber-50 rounded hover:bg-amber-100"
              >
                Select tenant moves ({tenantMoveCount})
              </button>
            )}
            <button
              type="button"
              onClick={selectTerminatedOnly}
              className="px-2 py-1 border rounded hover:bg-gray-50"
              title="Select households with termination dates who are not yet in AB365 — creates members + historical enrollments"
            >
              Terminated only (import history)
            </button>
          </div>
          )}
          {tenantMoveCount > 0 && (
            <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              <strong>{tenantMoveCount}</strong> household{tenantMoveCount !== 1 ? 's' : ''} already exist under another tenant and appear at the top of the list.
              They are <strong>not</strong> selected by default — review and check the box for each move you intend.
            </p>
          )}
          {(preview.statistics.planTerminationsPending ?? 0) > 0 && (
            <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
              <strong>{preview.statistics.planTerminationsPending}</strong> plan row(s) have termination dates for members
              not yet in AB365. Product mapping from step 1 still applies — expand a row to see mapped tiers.
              The <strong>Tier</strong> column is household coverage (EE/ES/EC/EF), not your catalog pricing tier.
              Click <strong>Terminated only (import history)</strong> to include them. Not related to tobacco.
            </p>
          )}

          <p className="text-xs text-gray-500">
            <span className="font-medium text-gray-700">Action</span> explains why a household is skipped (missing dependents, bad email, etc.).
            {' '}
            <span className="font-medium text-gray-700">Coverage</span> = family size from dependent rows in the file (EE/ES/EC/EF);
            <span className="font-medium text-fuchsia-800"> Needs ES/EC/EF</span> when the plan bills family but those rows are missing.
            {' '}
            <span className="font-medium text-gray-700">Plan changes</span> = catalog pricing after mapping (violet = tier change, gray = same plan).
            Click a row for details.
          </p>

          <div className="max-h-[28rem] overflow-auto border rounded-lg">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th className="p-2 w-8">
                    {!previewReadOnly && (
                      <input
                        type="checkbox"
                        aria-label={allSelectableSelected ? 'Deselect all households' : 'Select all households'}
                        checked={allSelectableSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = someSelectableSelected && !allSelectableSelected;
                        }}
                        onChange={() => (allSelectableSelected ? deselectAll() : selectAll())}
                      />
                    )}
                  </th>
                  <th className="text-left p-2">Action</th>
                  <th className="text-left p-2">Household (primary)</th>
                  <th className="text-left p-2">Coverage</th>
                  <th className="text-left p-2 min-w-[220px]">Plan changes</th>
                  <th className="text-left p-2">Member ID</th>
                  <th className="text-left p-2 min-w-[180px]">Agent</th>
                </tr>
              </thead>
              <tbody>
                {sortedHouseholds.map((h) => {
                  const isExpanded = expandedKey === h.householdKey;
                  const checked = selectedKeys.has(h.householdKey);
                  const skipDisplay = householdSkipReasonDisplay(h);
                  const blocked = isMissingDependentsHousehold(h) || h.importBlockedByEmail || h.action === 'skip';
                  return (
                    <React.Fragment key={h.householdKey}>
                      <tr
                        className={`border-t cursor-pointer ${actionRowClass(h.action, h.allPlansTerminated, h.importBlockedByEmail, isMissingDependentsHousehold(h))} ${checked || blocked ? '' : 'opacity-60'}`}
                        onClick={() => setExpandedKey(isExpanded ? null : h.householdKey)}
                      >
                        <td className="p-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={h.importBlockedByEmail || isMissingDependentsHousehold(h) || previewReadOnly}
                            onChange={() => toggleHousehold(h.householdKey)}
                          />
                        </td>
                        <td className="p-2 align-top">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${actionBadgeClass(h.action, h.importBlockedByEmail, isMissingDependentsHousehold(h))}`}>
                            {actionDisplayLabel(h)}
                          </span>
                          {skipDisplay && (
                            <p className="text-[11px] mt-1 max-w-[200px] leading-snug text-gray-700">
                              {skipDisplay.detail}
                            </p>
                          )}
                        </td>
                        <td className="p-2">
                          <div className="font-medium">{h.primaryName}</div>
                          {h.importBlockedByEmail && !skipDisplay && (
                            <div className="text-xs text-orange-700 mt-0.5">
                              Bad email (skipped)
                            </div>
                          )}
                          {h.dependentCount > 0 && (
                            <div className="text-xs text-gray-500 mt-0.5">
                              {isExpanded
                                ? `${h.dependentCount} dependent${h.dependentCount !== 1 ? 's' : ''} — click row to collapse`
                                : `${h.dependentCount} dependent${h.dependentCount !== 1 ? 's' : ''}: ${h.dependents.map((d) => d.name).join(', ')}`}
                            </div>
                          )}
                        </td>
                        <td className="p-2 text-gray-700">
                          {(() => {
                            const cov = coverageTierCellDisplay(h);
                            return (
                              <span title={cov.sub}>
                                <span className={`font-medium ${cov.isChanging ? 'text-violet-900' : ''}`}>
                                  {cov.main}
                                </span>
                                {cov.sub && !cov.isChanging && (
                                  <span className="block text-xs text-gray-500">{cov.sub}</span>
                                )}
                                {cov.isChanging && (
                                  <span className="block text-xs text-violet-700">{cov.sub}</span>
                                )}
                              </span>
                            );
                          })()}
                        </td>
                        <td className={`p-2 text-xs ${h.unmappedProducts.length > 0 ? 'text-amber-900' : 'text-gray-900'}`}>
                          <div>
                            {h.plans.length > 0 ? (
                              <ul className="space-y-1.5">
                                {sortPlanPreviewsForDisplay(h.plans).map((p) => {
                                  const line = formatPlanLineDisplay(p);
                                  return (
                                    <li key={`${p.planKey}-${p.memberLabel}-${p.action}`}>
                                      <div className="flex flex-wrap items-baseline gap-1">
                                        <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium ${planToneClass(line.tone)}`}>
                                          {line.statusLabel}
                                        </span>
                                        <span className={planLineTextClass(line.tone)}>
                                          {line.tierLabel}
                                        </span>
                                      </div>
                                      {line.detail && (
                                        <span className="block text-[11px] text-gray-600 mt-0.5">{line.detail}</span>
                                      )}
                                      {line.memberLabel && (
                                        <span className="block text-[11px] text-gray-500">for {line.memberLabel}</span>
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            ) : (
                              <span className="text-gray-500">{h.catalogMatchSummary || 'No plan rows in file'}</span>
                            )}
                            {(() => {
                              const chips = householdChangeChips(h);
                              if (!chips.length) return null;
                              return (
                                <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-1.5 pt-1 border-t border-gray-100">
                                  {chips.map((c) => (
                                    <span key={c.label} className={`text-[11px] ${c.className}`}>
                                      {c.label}
                                    </span>
                                  ))}
                                </div>
                              );
                            })()}
                            {skipDisplay && (
                              <span className={`block text-[11px] mt-1 font-medium ${isMissingDependentsHousehold(h) ? 'text-fuchsia-800' : 'text-gray-600'}`}>
                                {skipDisplay.detail}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="p-2 text-gray-600">{h.householdMemberId}</td>
                        <td className="p-2" onClick={(e) => e.stopPropagation()}>
                          <div className="min-w-[160px]">
                            <SearchableDropdown
                              options={agentDropdownOptions}
                              value={householdAgentByKey[h.householdKey] || ''}
                              onChange={(value) => setHouseholdAgent(h.householdKey, value)}
                              placeholder={agentsLoading ? 'Loading…' : 'No agent'}
                              disabled={agentsLoading || h.importBlockedByEmail || previewReadOnly}
                            />
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-white border-t">
                          <td colSpan={7} className="p-3">
                            {h.importBlockedByEmail && (h.emailIssues?.length ?? 0) > 0 && (
                              <div className="mb-3 rounded-lg border border-orange-200 bg-orange-50 p-3">
                                <div className="text-xs font-semibold text-orange-900 mb-1">Primary email issue</div>
                                <ul className="space-y-1 text-xs text-orange-900">
                                  {h.emailIssues?.map((issue, idx) => (
                                    <li key={idx}>
                                      <span className="font-medium">{issue.name}</span>:
                                      {' '}{issue.message}
                                      {issue.value ? ` — “${issue.value}”` : ''}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {(h.memberFieldChanges?.length ?? 0) > 0 && (
                              <div className="mb-3 rounded-lg border border-teal-200 bg-teal-50 p-3">
                                <div className="text-xs font-semibold text-teal-900 mb-1">Member field updates</div>
                                <ul className="space-y-1 text-xs">
                                  {h.memberFieldChanges!.map((ch, idx) => (
                                    <li key={idx} className="text-teal-950">
                                      {ch.who && <span className="text-teal-800">{ch.who}: </span>}
                                      <span className="font-medium">{memberFieldLabel(ch.field)}</span>
                                      {' '}
                                      <span className="line-through text-red-700/80">{ch.from}</span>
                                      {' → '}
                                      <span className="text-green-800 font-medium">{ch.to}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {h.plans.length > 0 && (
                              <div className="mb-2">
                                <div className="text-xs font-semibold text-gray-500 mb-1">Plan lines (file → catalog)</div>
                                <ul className="space-y-2">
                                  {sortPlanPreviewsForDisplay(h.plans).map((p) => {
                                    const line = formatPlanLineDisplay(p);
                                    return (
                                      <li key={`${p.planKey}-${p.memberLabel}-${p.action}`} className="text-xs border border-gray-100 rounded-md p-2 bg-gray-50">
                                        <div className="flex flex-wrap items-center gap-2 mb-1">
                                          <span className={`px-1.5 py-0.5 rounded font-medium ${planToneClass(line.tone)}`}>
                                            {line.statusLabel}
                                          </span>
                                          <span className="text-gray-700">{p.memberLabel}</span>
                                        </div>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 text-gray-700">
                                          <span><span className="text-gray-500">File code:</span> <span className="font-mono">{p.planKey}</span></span>
                                          {p.resolvedMapKey && p.resolvedMapKey !== p.planKey && (
                                            <span><span className="text-gray-500">Maps as:</span> <span className="font-mono">{p.resolvedMapKey}</span></span>
                                          )}
                                          {p.productName && (
                                            <span><span className="text-gray-500">Product:</span> {p.productName}</span>
                                          )}
                                          <span className={planLineTextClass(line.tone)}>
                                            <span className="text-gray-500">Tier: </span>
                                            {line.tierLabel}
                                          </span>
                                          {line.detail && (
                                            <span className="sm:col-span-2 text-gray-600">{line.detail}</span>
                                          )}
                                        </div>
                                      </li>
                                    );
                                  })}
                                </ul>
                              </div>
                            )}
                            {h.dependents.length > 0 && (
                              <div>
                                <div className="text-xs font-semibold text-gray-500 mb-1">Dependents</div>
                                <ul className="space-y-1">
                                  {h.dependents.map((d, i) => (
                                    <li key={i} className="text-xs flex gap-2 flex-wrap">
                                      <span className={d.action === 'create' ? 'text-purple-700 font-medium' : 'text-blue-700'}>
                                        {d.action === 'create' ? '+ new' : 'update'}
                                      </span>
                                      <span>{d.name}</span>
                                      <span className="text-gray-400">({d.relationship})</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {h.unmappedProducts.length > 0 && (
                              <div className="mt-2 text-xs text-amber-700">
                                Unmapped: {h.unmappedProducts.join(', ')}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!previewReadOnly && (
            <div className="flex gap-2">
              <button type="button" onClick={() => setStep('upload')} className="px-4 py-2 border rounded-lg text-sm">Back</button>
              <button
                type="button"
                disabled={loading || selectedCount === 0}
                onClick={() => void commit()}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg text-sm disabled:opacity-50"
              >
                {loading ? 'Importing…' : `Apply import (${selectedCount})`}
              </button>
            </div>
          )}
        </div>
      )}

    </div>
  );
};

export default VendorImportMembersWizard;
