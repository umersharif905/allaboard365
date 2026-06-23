import type { AxiosRequestConfig } from 'axios';
import { apiService } from './api.service';
import { getE123MigrationApiBase } from '../utils/e123MigrationPortal';

/** Default client timeout for migration API reads (households, agent mapping, product workspace). */
export const E123_MIGRATION_TIMEOUT_MS = 15 * 60 * 1000;
/** Agent catalog should respond quickly; long waits usually mean cold E123 index build on server. */
export const E123_MIGRATION_AGENT_CATALOG_TIMEOUT_MS = 90 * 1000;
/** Per-poll request while agent workspace builds (E123 fan-out can take a long time). */
export const E123_AGENT_MIGRATION_WORKSPACE_POLL_TIMEOUT_MS = 3 * 60 * 1000;
/** Stop polling only if no progress for this long (ms). */
export const E123_AGENT_MIGRATION_WORKSPACE_STALE_MS = 20 * 60 * 1000;
/** Absolute cap on workspace build wait (ms). */
export const E123_AGENT_MIGRATION_WORKSPACE_MAX_WAIT_MS = 3 * 60 * 60 * 1000;
/** Extended timeout for fetch kickoff, preview, and apply (backend may run for a long time). */
export const E123_MIGRATION_LONG_TIMEOUT_MS = 45 * 60 * 1000;

function migReq(long = false, timeoutMs?: number): AxiosRequestConfig {
  if (timeoutMs != null) return { timeout: timeoutMs };
  return { timeout: long ? E123_MIGRATION_LONG_TIMEOUT_MS : E123_MIGRATION_TIMEOUT_MS };
}

function migGet<T>(url: string, long = false, timeoutMs?: number) {
  return apiService.get<T>(url, migReq(long, timeoutMs));
}

function migPost<T>(url: string, data?: unknown, long = false) {
  return apiService.post<T>(url, data, migReq(long));
}

function migPatch<T>(url: string, data?: unknown, long = false) {
  return apiService.patch<T>(url, data, migReq(long));
}

type MigResponse<T> = { success: boolean; data: T; message?: string };

export interface MigrationBatch {
  BatchId: string;
  WizardStep: number;
  RootBrokerId: number | null;
  RootAgentLabel: string | null;
  IncludeDownline: boolean;
  TenantId: string | null;
  Status: string;
  FetchPagesCompleted: number;
  FetchMembersLoaded: number;
  FetchError: string | null;
  ApplyProcessed: number;
  ApplyTotal: number;
  ApplyCreateCount: number;
  ApplySkipCount: number;
  ApplyErrorCount: number;
  householdCount?: number;
  TenantName?: string;
  CreatedUtc?: string;
  ModifiedUtc?: string;
  SummaryJson?: string | null;
  displayRootAgentLabel?: string;
}

export interface MigrationFetchCoverage {
  householdCount: number;
  primarySsnCount: number;
  dependentCount: number;
  dependentSsnCount: number;
  paymentMethodCount: number;
  paymentMaskedOnly: number;
}

export interface AgentOption {
  rootBrokerId: number;
  rootAgentLabel?: string | null;
  label?: string;
  suggestedTenant?: string | null;
  includeDownline: boolean;
  tenantId?: string;
  tenantName?: string;
  parentLabel?: string;
  parentBrokerId?: number | null;
  childCount?: number;
  totalDownlineCount?: number;
  isOrgRoot?: boolean;
  isOrgDirect?: boolean;
  migrationStatus?: {
    alreadyMigrated: boolean;
    appliedCount?: number;
    tenantName?: string;
    appliedUtc?: string;
  };
}

export interface HouseholdSummaryRow {
  batchHouseholdId: string;
  e123UserId: number | null;
  householdMemberId: string;
  primaryName: string;
  dependentCount: number;
  productCount: number;
  brokerId: number | null;
  sellingAgentId: number | null;
  e123AgentBrokerId?: number | null;
  e123AgentName?: string | null;
  email: string | null;
  includedInImport: boolean;
  migrationState?: 'new' | 'pending_update' | 'locked';
  isPendingUpdate?: boolean;
  alreadyMigrated: boolean;
  appliedInBatch?: boolean;
  previewAction?: string | null;
  previewMessage?: string | null;
  e123PremiumTotal?: number | null;
  ab365PremiumTotal?: number | null;
  premiumMismatch?: boolean;
  premiumBreakdown?: Array<{
    pdid: number;
    benefitId?: number | null;
    /** @deprecated use e123Label */
    label?: string | null;
    e123Label?: string | null;
    ab365ProductId?: string | null;
    ab365ProductName?: string | null;
    ab365PricingLabel?: string | null;
    e123Amount: number;
    ab365Amount: number | null;
    tobaccoUse?: string | null;
    productPricingId?: string | null;
    matchStatus?: string;
  }>;
}

export interface BatchSelectionSummary {
  totalCount: number;
  selectedCount: number;
  selectedNewCount?: number;
  selectedPendingCount?: number;
  alreadyMigratedCount: number;
  lockedCount?: number;
  pendingUpdateCount?: number;
}

export interface E123AgentMappingBroker {
  e123BrokerId: number;
  e123AgentLabel: string;
  e123Email: string | null;
  e123FirstName: string | null;
  e123LastName: string | null;
  memberCount: number;
  agentId: string | null;
  agentName: string | null;
  agentEmail: string | null;
  agentTenantName?: string | null;
  matchMethod: string | null;
  matchStatus: 'mapped' | 'manual' | 'suggested' | 'needs_manual' | 'unmapped' | 'cross_tenant';
}

export interface E123AgentMappingWorkspace {
  brokers: E123AgentMappingBroker[];
  mappedCount: number;
  suggestedCount: number;
  unmappedCount: number;
  needsManualCount: number;
  crossTenantCount?: number;
  crossTenantMemberCount?: number;
  totalBrokers: number;
}

export interface TenantAgentSearchResult {
  linkType?: 'agent' | 'user';
  agentId: string | null;
  userId?: string | null;
  agentCode: string | null;
  displayName: string;
  email: string | null;
  hint?: string | null;
}

const AGENT_MAP_CACHE_PREFIX = 'e123-agent-mapping:';
const AGENT_MAP_CACHE_VERSION = 4;
const AGENT_MAP_CACHE_TTL_MS = 15 * 60 * 1000;
const agentMappingInflight = new Map<string, Promise<{ success: boolean; data: E123AgentMappingWorkspace; message?: string }>>();

function agentMappingCacheStorageKey(batchId: string, tenantId: string, selectionRevision = 0): string {
  return `${AGENT_MAP_CACHE_PREFIX}${batchId}:${tenantId}:r${selectionRevision}`;
}

export function readAgentMappingWorkspaceCache(
  batchId: string,
  tenantId: string,
  selectionRevision = 0
): E123AgentMappingWorkspace | null {
  try {
    const raw = sessionStorage.getItem(agentMappingCacheStorageKey(batchId, tenantId, selectionRevision));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { version?: number; savedAt: number; data: E123AgentMappingWorkspace };
    if (parsed.version !== AGENT_MAP_CACHE_VERSION) return null;
    if (Date.now() - parsed.savedAt > AGENT_MAP_CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function writeAgentMappingWorkspaceCache(
  batchId: string,
  tenantId: string,
  data: E123AgentMappingWorkspace,
  selectionRevision = 0
) {
  try {
    sessionStorage.setItem(
      agentMappingCacheStorageKey(batchId, tenantId, selectionRevision),
      JSON.stringify({ version: AGENT_MAP_CACHE_VERSION, savedAt: Date.now(), data })
    );
  } catch {
    // sessionStorage may be unavailable or full
  }
}

export function clearAgentMappingWorkspaceCache(
  batchId: string,
  tenantId: string,
  selectionRevision?: number
) {
  try {
    if (selectionRevision != null) {
      sessionStorage.removeItem(agentMappingCacheStorageKey(batchId, tenantId, selectionRevision));
      return;
    }
    const prefix = `${AGENT_MAP_CACHE_PREFIX}${batchId}:${tenantId}:`;
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(prefix)) sessionStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

/** Drop all cached agent-mapping workspaces for a batch (any tenant / revision). */
export function clearAgentMappingWorkspaceCacheForBatch(batchId: string) {
  try {
    const prefix = `${AGENT_MAP_CACHE_PREFIX}${batchId}:`;
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(prefix)) sessionStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}
export interface AgentLookupResult {
  agent: { id: number; label: string; active?: boolean; parent?: unknown } | null;
  parentChain: Array<{ id: number; label: string }>;
}

export interface UnmappedProduct {
  sourceProductKey: string;
  sourceBenefitKey: string | null;
  sourceBenefitLabel?: string | null;
  sourceProductLabel: string;
  memberCount: number;
  mapped: boolean;
}

export interface MigrationSubscribedProduct {
  productId: string;
  name: string;
  productType?: string;
  isBundle: boolean;
  isHidden?: boolean;
  productKind: string;
  salesType: string;
  salesTypeLabel: string;
  vendorId?: string;
  vendorName: string;
  subscriptionStatus?: string | null;
  catalogSource?: 'subscribed' | 'owned' | 'both';
  productImageUrl?: string | null;
  productLogoUrl?: string | null;
}

export interface MigrationPricingOption {
  productPricingId: string;
  label: string;
  pricingName?: string;
  tierType?: string;
  configValue1?: string;
  configValue2?: string;
  minAge?: number;
  maxAge?: number;
  tobaccoStatus?: string;
  netRate?: number | null;
  overrideRate?: number | null;
  msrpRate?: number | null;
  totalRate?: number | null;
  displayRate?: number | null;
  includeProcessingFee?: boolean;
  includedProcessingFee?: number | null;
  displayLabel: string;
}

export type VendorBucketChoice = 'net' | 'override' | 'exclude';

export interface E123VendorRoutingRow {
  routingKey: string;
  vendorId: number | null;
  vendorName: string;
  amountLabel: string;
  amounts: number[];
  appliesTo: string;
  defaultBucket: VendorBucketChoice;
  selectedBucket: VendorBucketChoice;
  isMerchantFee?: boolean;
}

export interface E123VendorRoutingPreview {
  hasRouting: boolean;
  vendors: E123VendorRoutingRow[];
  missingSnapshot?: boolean;
}

export interface E123ProductWizardDraftMeta {
  sourceProductKey: string;
  sourceProductLabel: string;
  mappingMethod: 'deterministic';
  templateProductId?: string | null;
  templateProductName?: string | null;
  usedSharewellCatalog: boolean;
  usedCsvSnapshot?: boolean;
  csvSnapshotModifiedUtc?: string | null;
  csvSnapshotTierCount?: number;
  pricingFromCsvSnapshot?: boolean;
  usedE123AgentCatalog: boolean;
  usedE123RateApi?: boolean;
  e123RateApiError?: string | null;
  pricingTierCount: number;
  configurationFieldCount: number;
  vendorResolutionReason?: string;
  vendorRouting?: E123VendorRoutingPreview;
  vendorBucketOverrides?: Record<string, VendorBucketChoice>;
  prefilledSections?: string[];
  warnings: string[];
}

export interface E123ProductWizardDraftResponse {
  formData: Record<string, unknown>;
  meta: E123ProductWizardDraftMeta;
}

export interface PremiumMatch {
  status: 'exact' | 'close' | 'mismatch' | 'unknown';
  e123Amount?: number | null;
  ab365Amount?: number | null;
  diff?: number | null;
}

export interface E123CatalogPricingRow {
  benefitId?: string | null;
  benefitLabel?: string | null;
  amount: number;
  memberAgeMin?: number | null;
  memberAgeMax?: number | null;
  period?: string | null;
  displayStart?: string | null;
  source?: 'catalog' | 'getrates' | null;
}

export interface E123CatalogPricingStats {
  min: number;
  max: number;
  median: number;
  average: number;
  sampleSize: number;
  sources?: Array<'catalog' | 'getrates'>;
  rows: E123CatalogPricingRow[];
}

export interface E123ProductMappingTier {
  sourceBenefitKey: string | null;
  sourceBenefitLabel?: string | null;
  memberCount: number;
  memberTierCounts?: Record<string, number>;
  inferredMemberTier?: string | null;
  tierConfidence?: number;
  tierBreakdownLabel?: string | null;
  tobaccoCounts?: { yes: number; no: number; unknown: number };
  inferredTobaccoUse?: 'Yes' | 'No' | null;
  tobaccoConfidence?: number;
  tobaccoBreakdownLabel?: string | null;
  memberAgeRange?: { min: number; max: number; median: number; sampleSize: number } | null;
  feeHints?: {
    benefitLabel?: string | null;
    periodLabel?: string | null;
    amount?: number | null;
    unsharedAmount?: number | null;
    feeType?: string | null;
    tierFromLabel?: string | null;
  } | null;
  feeAmountStats?: {
    min: number;
    max: number;
    median: number;
    average: number;
    sampleSize: number;
  } | null;
  catalogPricing?: E123CatalogPricingStats | null;
  resolvedTier?: string | null;
  displayHint?: string | null;
  needsDualTobaccoMapping?: boolean;
  premiumMatch?: PremiumMatch | null;
  tobaccoPremiumMatch?: PremiumMatch | null;
  mapped: boolean;
  savedMap?: {
    productId: string;
    productPricingId?: string | null;
    productPricingIdTobacco?: string | null;
    sourceProductLabel?: string | null;
  } | null;
  suggestedProductId?: string | null;
  suggestedPricingId?: string | null;
  suggestedPricingIdTobacco?: string | null;
  suggestReason?: string | null;
  ignored?: boolean;
}

export interface E123EnrollmentStats {
  enrollmentCreatedRange?: {
    min: string;
    max: string;
    minLabel: string;
    maxLabel: string;
    sampleSize: number;
  } | null;
  effectiveDateRange?: {
    min: string;
    max: string;
    minLabel: string;
    maxLabel: string;
    sampleSize: number;
  } | null;
  billingDateRange?: {
    min: string;
    max: string;
    minLabel: string;
    maxLabel: string;
    sampleSize: number;
  } | null;
  activeEnrollmentCount: number;
  cancelledEnrollmentCount: number;
  onHoldEnrollmentCount: number;
  unpaidEnrollmentCount: number;
  enrollmentSummaryLabel?: string | null;
}

export interface E123ProductCatalogStatus {
  inAgentCatalog: boolean | null;
  catalogActive?: boolean | null;
  catalogLabel?: string | null;
  catalogCategory?: string | null;
  catalogUnderwriter?: string | null;
  catalogStatusLabel?: string | null;
}

export interface E123TobaccoPricingRecommendation {
  recommended: boolean;
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  reasonsFor: string[];
  reasonsAgainst: string[];
  rateGridTobaccoPairs?: number;
  maxTobaccoSurcharge?: number | null;
}

export interface E123ProductMappingGroup {
  sourceProductKey: string;
  sourceProductLabel: string;
  memberCount: number;
  enrollmentStats?: E123EnrollmentStats | null;
  catalogStatus?: E123ProductCatalogStatus | null;
  catalogCategory?: string | null;
  salesType?: string;
  salesTypeLabel?: string;
  duplicateLabelCount?: number;
  allTiersMapped: boolean;
  ignored?: boolean;
  suggestedProductId?: string | null;
  tobaccoPricingRecommendation?: E123TobaccoPricingRecommendation | null;
  tiers: E123ProductMappingTier[];
}

export interface ProductMappingWorkspace {
  e123ProductGroups: E123ProductMappingGroup[];
  subscribedProducts: MigrationSubscribedProduct[];
  allMapped: boolean;
  householdCount?: number;
  duplicateLabelGroups?: number;
  instanceId?: string;
  instanceTenantCount?: number;
}

export interface ProductMapSummaryEntry {
  sourceProductKey: string;
  sourceProductLabel: string;
  tierCount: number;
  mappedCount: number;
  ignoredCount: number;
  ab365ProductName: string | null;
  ab365ProductId: string | null;
  status: 'mapped' | 'ignored' | 'partial' | 'unmapped';
}

export interface ProductMapSummary {
  totalProducts: number;
  mappedProducts: number;
  ignoredProducts: number;
  partialProducts: number;
  products: ProductMapSummaryEntry[];
}

export interface E123CatalogFileType {
  kind: string;
  label: string;
}

export interface E123CatalogSnapshotStatus {
  configured: boolean;
  rootBrokerId: number | null;
  productCount: number;
  requiredFileTypes: E123CatalogFileType[];
  latestExport: {
    exportId: string;
    rootBrokerId: number;
    productCount: number;
    fileManifest: Array<{ kind: string; kindLabel: string; originalName: string | null; rowCount: number }>;
    missingKinds: E123CatalogFileType[];
    createdUtc: string;
  } | null;
}

export interface E123CatalogImportResult {
  exportId: string;
  rootBrokerId: number;
  productCount: number;
  missingKinds: E123CatalogFileType[];
  fileManifest: Array<{ kind: string; kindLabel: string; originalName: string | null; rowCount: number }>;
  products: Array<{ pdid: number; label: string | null; pricingTierCount: number }>;
}

export interface E123AgentTreeNode {
  agentId: number;
  parentAgentId: number | null;
  label: string;
  parentLabel?: string | null;
  depth: number;
  sortOrder: number;
  childCount: number;
  totalDownlineCount?: number;
  isGroup?: boolean | null;
  hasChildren: boolean;
}

export interface E123AgentTreeSnapshotStatus {
  configured: boolean;
  instanceId: string | null;
  nodeCount: number;
  latestExport: {
    exportId: string;
    instanceId: string;
    rootBrokerId: number;
    rootLabel: string | null;
    sourceFormat: string | null;
    fileName: string | null;
    nodeCount: number;
    createdUtc: string;
  } | null;
}

export interface E123AgentTreeImportResult {
  exportId: string;
  instanceId: string;
  rootBrokerId: number;
  rootLabel: string | null;
  sourceFormat: string | null;
  fileName: string | null;
  nodeCount: number;
}

export interface E123PayablesSnapshotStatus {
  configured: boolean;
  instanceId: string | null;
  agentCount: number;
  latestExport: {
    exportId: string;
    fileName: string | null;
    rowCount: number;
    agentCount: number;
    dominantMonth: string | null;
    minPostedDate: string | null;
    maxPostedDate: string | null;
    warnings: string[];
    createdUtc: string;
  } | null;
}

export interface E123PayablesImportResult {
  exportId: string;
  fileName: string | null;
  rowCount: number;
  agentCount: number;
  dominantMonth: string | null;
  commProductRowCount?: number;
  warnings?: string[];
  uploadedUtc: string;
}

export interface E123GroupsListSnapshotStatus {
  configured: boolean;
  instanceId: string | null;
  groupCount: number;
  latestExport: {
    exportId: string;
    fileName: string | null;
    rowCount: number;
    groupCount: number;
    warnings: string[];
    createdUtc: string;
  } | null;
}

export interface E123GroupsListImportResult {
  exportId: string;
  fileName: string | null;
  rowCount: number;
  groupCount: number;
  warnings?: string[];
  uploadedUtc: string;
}

export interface MigrationApplyResult {
  started?: boolean;
  applyTotal?: number;
  applyProcessed?: number;
  createCount: number;
  updateCount?: number;
  skipCount: number;
  lockedCount?: number;
  errorCount: number;
  processed?: number;
  status?: string;
  results?: Array<{
    batchHouseholdId: string;
    householdMemberId: string;
    primaryName: string;
    action: string;
    message?: string | null;
  }>;
}

export interface PreviewRow {
  batchHouseholdId: string;
  householdMemberId: string;
  primaryName: string;
  tier?: string;
  dependentCount: number;
  productCount: number;
  ab365AgentId?: string | null;
  ab365AgentName?: string | null;
  ab365AgentCrossTenant?: boolean;
  action: string;
  message: string;
  e123PremiumTotal?: number | null;
  ab365PremiumTotal?: number | null;
  premiumMismatch?: boolean;
  premiumBreakdown?: HouseholdSummaryRow['premiumBreakdown'];
  premiumOffsetAdjustment?: number | null;
  premiumOffsetApplied?: boolean;
}

export interface MigrationImportSettings {
  offsetProcessingFeeForPremiumMatch?: boolean;
  includeTerminatedHouseholds?: boolean;
}

export function parseBatchImportSettings(summaryJson?: string | null): MigrationImportSettings {
  if (!summaryJson) return {};
  try {
    const parsed = JSON.parse(summaryJson) as { importSettings?: MigrationImportSettings };
    return parsed.importSettings || {};
  } catch {
    return {};
  }
}

export interface BatchFetchProgress {
  phase?: string | null;
  householdsSaved?: number | null;
  householdsTotal?: number | null;
}

export function parseBatchFetchProgress(summaryJson?: string | null): BatchFetchProgress {
  if (!summaryJson) return {};
  try {
    const parsed = JSON.parse(summaryJson) as { fetchProgress?: BatchFetchProgress };
    return parsed.fetchProgress || {};
  } catch {
    return {};
  }
}

export interface MigrationInstance {
  instanceId: string;
  label: string;
  e123CorpId?: string | null;
  e123Username?: string | null;
  e123Password?: string | null;
  hasPassword?: boolean;
  orgBrokerId?: number | null;
  orgBrokerLabel?: string | null;
  isArchived?: boolean;
  enableTenantPortal?: boolean;
  tenantCount?: number;
  tenants?: Array<{ TenantId: string; TenantName: string }>;
}

function base() {
  return getE123MigrationApiBase();
}

function withInstanceQuery(path: string, instanceId?: string | null) {
  if (!instanceId) return path;
  const join = path.includes('?') ? '&' : '?';
  return `${path}${join}instanceId=${encodeURIComponent(instanceId)}`;
}

export const e123MigrationService = {
  getPortalStatus: () =>
    migGet<{ success: boolean; data: { enabled: boolean; instanceId: string | null; label: string | null } }>(
      `${base()}/portal-status`
    ),

  getTenantPortalNavStatus: () =>
    migGet<{ success: boolean; data: { enabled: boolean; instanceId: string | null; label: string | null } }>(
      '/api/me/tenant-admin/e123-migration/portal-status'
    ),

  listInstances: () =>
    migGet<{ success: boolean; data: MigrationInstance[] }>(`${base()}/instances`),

  getInstance: (instanceId: string) =>
    migGet<MigResponse<MigrationInstance>>(`${base()}/instances/${instanceId}`),

  createInstance: (payload: {
    label: string;
    e123CorpId?: string;
    e123Username?: string;
    e123Password?: string;
    orgBrokerId?: number | null;
    orgBrokerLabel?: string;
    enableTenantPortal?: boolean;
    tenantIds?: string[];
  }) => migPost<MigResponse<MigrationInstance>>(`${base()}/instances`, payload),

  updateInstance: (instanceId: string, payload: Record<string, unknown>) =>
    migPatch<MigResponse<MigrationInstance>>(`${base()}/instances/${instanceId}`, payload),

  listAvailableTenantsForInstance: (instanceId: string) =>
    migGet<{ success: boolean; data: Array<{ TenantId: string; Name: string }> }>(
      `${base()}/instances/${instanceId}/available-tenants`
    ),

  getConfigStatus: (instanceId?: string | null) =>
    migGet<{ success: boolean; data: {
      memberSearchConfigured: boolean;
      adminV2Configured: boolean;
      sharewellAgentsConfigured?: boolean;
      orgBrokerConfigured?: boolean;
      resolvedOrgBrokerId?: number | null;
      usesInstanceCredentials?: boolean;
    } }>(withInstanceQuery(`${base()}/config-status`, instanceId)),

  lookupAgent: (brokerId: number | string, instanceId?: string | null) =>
    migGet<{ success: boolean; data: AgentLookupResult }>(
      withInstanceQuery(`${base()}/agents/lookup/${brokerId}`, instanceId)
    ),

  getAgentOptions: (topLevelOnly = true, instanceId?: string | null) =>
    migGet<MigResponse<{
      presets: AgentOption[];
      savedMappings: AgentOption[];
      agents: AgentOption[];
      agentsTotalCount: number;
      source: string;
      sharewellConfigured: boolean;
      agentTreeConfigured?: boolean;
      agentTreeNodeCount?: number;
      agentTreeExport?: E123AgentTreeSnapshotStatus['latestExport'];
      topLevelOnly?: boolean;
      indexBuilding?: boolean;
      memberSearchConfigured?: boolean;
      orgBrokerConfigured?: boolean;
      resolvedOrgBrokerId?: number | null;
      diagnostics?: {
        memberSearchConfigured?: boolean;
        orgBrokerConfigured?: boolean;
        orgBrokerDiscovering?: boolean;
        orgBrokerSavedOnInstance?: boolean;
        resolvedOrgBrokerId?: number | null;
        issues?: string[];
        notes?: string[];
        indexStatus?: { lastBuildError?: string | null };
      };
      indexStatus?: {
        ready: boolean;
        building: boolean;
        totalCount: number;
        source: string | null;
        lastBuildError?: string | null;
      };
    }>>(
      withInstanceQuery(`${base()}/agents/options?topLevelOnly=${topLevelOnly ? '1' : '0'}`, instanceId),
      false,
      E123_MIGRATION_AGENT_CATALOG_TIMEOUT_MS
    ),

  searchAgents: (query: string, limit = 100, topLevelOnly = true, instanceId?: string | null) =>
    migGet<{ success: boolean; data: {
      agents: AgentOption[];
      totalCount: number;
      source: string;
      sharewellConfigured: boolean;
      topLevelOnly?: boolean;
      indexBuilding?: boolean;
    } }>(
      withInstanceQuery(
        `${base()}/agents/search?q=${encodeURIComponent(query)}&limit=${limit}&topLevelOnly=${topLevelOnly ? '1' : '0'}`,
        instanceId
      ),
      false,
      E123_MIGRATION_AGENT_CATALOG_TIMEOUT_MS
    ),

  /** Lightweight tenant list (migration router). Falls back to admin tenants if needed. */
  listTenants: async (instanceId?: string | null) => {
    type TenantsResponse = {
      success: boolean;
      data: Array<{ TenantId: string; Name: string; Status?: string; TenantName?: string }>;
      message?: string;
    };
    try {
      const res = await migGet<TenantsResponse>(withInstanceQuery(`${base()}/tenants`, instanceId));
      if (res.success && res.data) {
        return {
          ...res,
          data: res.data.map((row) => ({
            TenantId: row.TenantId,
            Name: row.Name || row.TenantName || row.TenantId,
            Status: row.Status
          }))
        };
      }
      return res;
    } catch {
      return migGet<TenantsResponse>('/api/admin/tenants');
    }
  },

  listAgentMappings: () =>
    migGet<{ success: boolean; data: unknown[] }>(`${base()}/agent-mappings`),

  listPending: (instanceId?: string | null) =>
    migGet<{ success: boolean; data: unknown[] }>(withInstanceQuery(`${base()}/pending`, instanceId)),

  listHistory: (instanceId?: string | null) =>
    migGet<{ success: boolean; data: MigrationBatch[] }>(withInstanceQuery(`${base()}/history`, instanceId)),

  createBatch: (payload: {
    rootBrokerId: number;
    rootAgentLabel?: string;
    includeDownline?: boolean;
    instanceId?: string | null;
    importSettings?: MigrationImportSettings;
  }) => migPost<{ success: boolean; data: MigrationBatch }>(`${base()}/batches`, payload, true),

  getBatch: (batchId: string) =>
    migGet<{ success: boolean; data: MigrationBatch }>(`${base()}/batches/${batchId}`),

  patchBatch: (batchId: string, payload: Record<string, unknown>) =>
    migPatch<{ success: boolean; data: MigrationBatch }>(`${base()}/batches/${batchId}`, payload),

  discardBatch: (batchId: string, options?: { force?: boolean }) =>
    migPost<MigResponse<{ batchId: string; status: string }>>(
      `${base()}/batches/${batchId}/discard`,
      options?.force ? { force: true } : {}
    ),

  getFetchStatus: (batchId: string) =>
    migGet<{ success: boolean; data: {
      status: string;
      pagesCompleted: number;
      membersLoaded: number;
      rawUsersLoaded?: number | null;
      householdCount?: number | null;
      fetchError: string | null;
      wizardStep: number;
      fetchPhase?: string | null;
      householdsSaved?: number | null;
      householdsTotal?: number | null;
    } }>(
      `${base()}/batches/${batchId}/fetch-status`
    ),

  restartFetch: (batchId: string) =>
    migPost<{ success: boolean; message?: string }>(`${base()}/batches/${batchId}/fetch`, {}, true),

  getBatchHouseholds: (
    batchId: string,
    page = 1,
    pageSize = 50,
    search = '',
    options?: { includePremium?: boolean }
  ) => {
    const premiumQs = options?.includePremium ? '&includePremium=1' : '';
    return migGet<{ success: boolean; data: { rows: HouseholdSummaryRow[]; total: number; page: number; pageSize: number; selection: BatchSelectionSummary }; message?: string }>(
      `${base()}/batches/${batchId}/households?page=${page}&pageSize=${pageSize}&search=${encodeURIComponent(search)}${premiumQs}`
    );
  },

  updateHouseholdSelection: (batchId: string, payload: {
    batchHouseholdIds?: string[];
    included?: boolean;
    all?: boolean;
    search?: string;
  }) => migPatch<MigResponse<BatchSelectionSummary>>(
    `${base()}/batches/${batchId}/households/selection`,
    payload
  ),

  deselectPremiumMismatches: (batchId: string) =>
    migPost<{ success: boolean; data: { deselectedCount: number; selection: BatchSelectionSummary } }>(
      `${base()}/batches/${batchId}/households/deselect-premium-mismatches`,
      {},
      true
    ),

  selectNewHouseholdsOnly: (batchId: string) =>
    migPost<MigResponse<{ selection: BatchSelectionSummary }>>(
      `${base()}/batches/${batchId}/households/select-new-only`,
      {},
      true
    ),

  selectPendingMigrationHouseholds: (batchId: string) =>
    migPost<MigResponse<{ selection: BatchSelectionSummary }>>(
      `${base()}/batches/${batchId}/households/select-pending-migration`,
      {},
      true
    ),

  selectHouseholdsByMemberIds: (
    batchId: string,
    payload: { householdMemberIds: string; replaceSelection?: boolean }
  ) =>
    migPost<MigResponse<{
      selection: BatchSelectionSummary;
      requestedCount: number;
      matchedCount: number;
      notInBatchCount: number;
      notInBatchIds: string[];
    }>>(
      `${base()}/batches/${batchId}/households/select-by-member-ids`,
      payload,
      true
    ),

  getUnmappedProducts: (batchId: string) =>
    migGet<{ success: boolean; data: UnmappedProduct[] }>(`${base()}/batches/${batchId}/products/unmapped`),

  getProductMappingWorkspace: (batchId: string, tenantId?: string) => {
    const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
    return migGet<{ success: boolean; data: ProductMappingWorkspace }>(
      `${base()}/batches/${batchId}/products/mapping${qs}`
    );
  },

  getAgentMappingWorkspace: (batchId: string, tenantId: string, options?: { force?: boolean }) => {
    const key = `${batchId}:${tenantId}`;
    if (!options?.force) {
      const inflight = agentMappingInflight.get(key);
      if (inflight) return inflight;
    }
    const promise = migGet<{ success: boolean; data: E123AgentMappingWorkspace; message?: string }>(
      `${base()}/batches/${batchId}/agents/mapping?tenantId=${encodeURIComponent(tenantId)}`
    ).finally(() => {
      if (agentMappingInflight.get(key) === promise) {
        agentMappingInflight.delete(key);
      }
    });
    agentMappingInflight.set(key, promise);
    return promise;
  },

  searchTenantAgents: (tenantId: string, search = '', limit = 30) =>
    migGet<{ success: boolean; data: TenantAgentSearchResult[] }>(
      `${base()}/tenants/${tenantId}/agents/search?q=${encodeURIComponent(search)}&limit=${limit}`
    ),

  saveAgentMap: (payload: {
    instanceId: string;
    e123BrokerId: number;
    agentId: string;
    e123AgentLabel?: string | null;
    tenantId?: string;
  }) => migPost<{ success: boolean; message?: string }>(`${base()}/agents/maps`, payload),

  getTenantProductMappingWorkspace: (tenantId: string, batchId?: string, instanceId?: string) => {
    const params = new URLSearchParams();
    if (batchId) params.set('batchId', batchId);
    if (instanceId) params.set('instanceId', instanceId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return migGet<{ success: boolean; data: ProductMappingWorkspace }>(
      `${base()}/tenants/${tenantId}/products/mapping-workspace${qs}`
    );
  },

  getProductMapSummary: (instanceId: string) =>
    migGet<{ success: boolean; data: ProductMapSummary }>(
      `${base()}/instances/${instanceId}/products/map-summary`
    ),

  getProductMapSummaryForTenant: (tenantId: string, instanceId?: string) => {
    const qs = instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '';
    return migGet<{ success: boolean; data: ProductMapSummary }>(
      `${base()}/tenants/${tenantId}/products/map-summary${qs}`
    );
  },

  getSubscribedProducts: (tenantId: string) =>
    migGet<{ success: boolean; data: MigrationSubscribedProduct[] }>(`${base()}/tenants/${tenantId}/subscribed-products`),

  getProductPricing: (productId: string) =>
    migGet<{ success: boolean; data: MigrationPricingOption[] }>(`${base()}/products/${productId}/pricing`),

  suggestTierPricing: (productId: string, tiers: Array<Record<string, unknown>>) =>
    migPost<{ success: boolean; data: Array<{
      sourceBenefitKey: string | null;
      productPricingId: string | null;
      productPricingIdTobacco?: string | null;
      suggestReason: string | null;
    }> }>(`${base()}/products/suggest-tier-pricing`, { productId, tiers }),

  saveProductMapsBulk: (instanceId: string, mappings: Array<{
    sourceProductKey: string;
    sourceBenefitKey?: string | null;
    sourceProductLabel?: string;
    productId?: string;
    productPricingId?: string | null;
    productPricingIdTobacco?: string | null;
    ignoreImport?: boolean;
  }>) =>
    migPost(`${base()}/products/maps/bulk`, { instanceId, mappings }),

  unignoreProductMap: (instanceId: string, sourceProductKey: string) =>
    migPost(`${base()}/products/maps/unignore`, { instanceId, sourceProductKey }),

  unsyncProductMap: (instanceId: string, sourceProductKey: string) =>
    migPost(`${base()}/products/maps/unsync`, { instanceId, sourceProductKey }),

  getE123VendorRoutingPreview: (
    tenantId: string,
    sourceProductKey: string,
    batchId?: string
  ) => {
    const query = batchId ? `?batchId=${encodeURIComponent(batchId)}` : '';
    return migGet<{ success: boolean; data: E123VendorRoutingPreview; message?: string }>(
      `${base()}/tenants/${tenantId}/products/e123-vendor-routing/${encodeURIComponent(sourceProductKey)}${query}`
    );
  },

  getE123ProductWizardDraft: (
    tenantId: string,
    sourceProductKey: string,
    batchId?: string,
    vendorBucketOverrides?: Record<string, VendorBucketChoice>,
    useTobaccoPricing?: boolean,
    templateProductId?: string | null
  ) => {
    const params = new URLSearchParams();
    if (batchId) params.set('batchId', batchId);
    if (vendorBucketOverrides && Object.keys(vendorBucketOverrides).length > 0) {
      params.set('vendorBucketOverrides', JSON.stringify(vendorBucketOverrides));
    }
    if (useTobaccoPricing !== undefined) {
      params.set('useTobaccoPricing', useTobaccoPricing ? '1' : '0');
    }
    if (templateProductId !== undefined) {
      params.set('templateProductId', templateProductId ?? 'none');
    }
    const query = params.toString() ? `?${params.toString()}` : '';
    return migGet<{ success: boolean; data: E123ProductWizardDraftResponse; message?: string }>(
      `${base()}/tenants/${tenantId}/products/e123-wizard-draft/${encodeURIComponent(sourceProductKey)}${query}`
    );
  },

  saveProductMap: (payload: {
    instanceId: string;
    sourceProductKey: string;
    sourceBenefitKey?: string | null;
    sourceProductLabel?: string;
    productId: string;
    productPricingId?: string | null;
  }) => migPost(`${base()}/products/map`, payload),

  createStubProduct: (payload: {
    tenantId: string;
    name: string;
    vendorId: string;
    productOwnerId: string;
    configValue1?: string | null;
  }) => migPost<{ success: boolean; data: { productId: string; productPricingId: string } }>(`${base()}/products/stub`, payload),

  getPreview: (
    batchId: string,
    page = 1,
    pageSize = 50,
    options?: { chunkOffset?: number; chunkSize?: number }
  ) => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize)
    });
    if (options?.chunkOffset != null) params.set('chunkOffset', String(options.chunkOffset));
    if (options?.chunkSize != null) params.set('chunkSize', String(options.chunkSize));
    return migGet<MigResponse<{
      rows: PreviewRow[];
      total: number;
      pageRowCount?: number;
      chunkOffset?: number;
      chunkSize?: number;
      chunkComplete?: boolean;
      summary?: {
        createCount: number;
        updateCount?: number;
        skipCount: number;
        lockedCount?: number;
        importedCount?: number;
        errorCount: number;
        total: number;
      } | null;
      selection?: BatchSelectionSummary;
    }>>(
      `${base()}/batches/${batchId}/preview?${params.toString()}`,
      true
    );
  },

  getSummary: (batchId: string) =>
    migGet<MigResponse<{ createCount: number; skipCount: number; errorCount: number; total: number }>>(
      `${base()}/batches/${batchId}/summary`,
      true
    ),

  applyBatch: (batchId: string, options?: { force?: boolean }) =>
    migPost<{ success: boolean; data: MigrationApplyResult; message?: string }>(
      `${base()}/batches/${batchId}/apply`,
      { force: options?.force === true },
      false
    ),

  releaseApplyLock: (batchId: string) =>
    migPost<{ success: boolean; data: { batchId: string; status: string; applyProcessed: number; applyTotal: number } }>(
      `${base()}/batches/${batchId}/release-apply-lock`,
      {},
      false
    ),

  getApplyStatus: (batchId: string) =>
    migGet<MigResponse<{
      status: string;
      applyProcessed: number;
      applyTotal: number;
      applyCreateCount: number;
      applySkipCount: number;
      applyErrorCount: number;
      modifiedUtc?: string | null;
      results?: Array<{
        batchHouseholdId: string;
        householdMemberId: string;
        primaryName: string;
        action: string;
        message: string | null;
      }> | null;
    }>>(
      `${base()}/batches/${batchId}/apply-status`,
      true
    ),

  pollApplyUntilDone: async (
    batchId: string,
    onProgress?: (data: {
      status: string;
      applyProcessed: number;
      applyTotal: number;
      applyCreateCount: number;
      applySkipCount: number;
      applyErrorCount: number;
      modifiedUtc?: string | null;
      results?: Array<{
        batchHouseholdId: string;
        householdMemberId: string;
        primaryName: string;
        action: string;
        message: string | null;
      }> | null;
    }) => void,
    options?: { maxWaitMs?: number; stallMs?: number }
  ) => {
    const maxWaitMs = options?.maxWaitMs ?? 2 * 60 * 60 * 1000;
    const stallMs = options?.stallMs ?? 10 * 60 * 1000;
    const started = Date.now();
    let pollCount = 0;
    let lastProcessed = -1;
    let lastProgressAt = Date.now();

    while (Date.now() - started < maxWaitMs) {
      const res = await e123MigrationService.getApplyStatus(batchId);
      if (!res.success || !res.data) {
        throw new Error(res.message || 'Failed to read apply status');
      }
      onProgress?.(res.data);
      const { status, applyProcessed, applyTotal, results } = res.data;
      if (applyProcessed > lastProcessed) {
        lastProcessed = applyProcessed;
        lastProgressAt = Date.now();
      }
      const terminalStatus = status === 'applied' || status === 'failed';
      const finishedByProgress = applyTotal > 0 && applyProcessed >= applyTotal;
      const finishedByResults = (results?.length ?? 0) > 0 && applyTotal > 0 && applyProcessed >= applyTotal;
      if (terminalStatus || finishedByProgress || finishedByResults) return res.data;
      if (Date.now() - lastProgressAt > stallMs) {
        throw new Error(
          `Import has not progressed in ${Math.round(stallMs / 60000)} minutes — check backend logs. `
          + 'If households are still importing, wait and refresh apply status before retrying.'
        );
      }
      pollCount += 1;
      const delayMs = pollCount <= 8 ? 500 : pollCount <= 24 ? 1000 : 2000;
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }
    throw new Error(
      'Import exceeded the maximum wait time (2 hours). Check backend logs — the job may still be running.'
    );
  },

  getE123CatalogStatus: (rootBrokerId?: number, instanceId?: string | null) => {
    const params = new URLSearchParams();
    if (rootBrokerId) params.set('rootBrokerId', String(rootBrokerId));
    let path = `${base()}/e123-catalog/status`;
    if (params.toString()) path += `?${params.toString()}`;
    return migGet<{ success: boolean; data: E123CatalogSnapshotStatus }>(withInstanceQuery(path, instanceId));
  },

  importE123Catalog: (files: File[], rootBrokerId?: number, instanceId?: string | null) => {
    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }
    if (rootBrokerId) formData.append('rootBrokerId', String(rootBrokerId));
    if (instanceId) formData.append('instanceId', instanceId);
    return migPost<{ success: boolean; data: E123CatalogImportResult; message?: string }>(
      `${base()}/e123-catalog/import`,
      formData,
      true
    );
  },

  listE123CatalogProducts: (rootBrokerId?: number, instanceId?: string | null) => {
    const params = new URLSearchParams();
    if (rootBrokerId) params.set('rootBrokerId', String(rootBrokerId));
    let path = `${base()}/e123-catalog/products`;
    if (params.toString()) path += `?${params.toString()}`;
    return migGet<{ success: boolean; data: Array<{ pdid: number; label: string | null; pricingTierCount: number; modifiedUtc: string }> }>(
      withInstanceQuery(path, instanceId)
    );
  },

  getE123CatalogProductSnapshot: (pdid: number | string, rootBrokerId?: number, instanceId?: string | null) => {
    const params = new URLSearchParams();
    if (rootBrokerId) params.set('rootBrokerId', String(rootBrokerId));
    let path = `${base()}/e123-catalog/products/${encodeURIComponent(String(pdid))}`;
    if (params.toString()) path += `?${params.toString()}`;
    return migGet<{ success: boolean; data: unknown; message?: string }>(
      withInstanceQuery(path, instanceId)
    );
  },

  getAgentTreeStatus: (instanceId?: string | null) =>
    migGet<{ success: boolean; data: E123AgentTreeSnapshotStatus }>(
      withInstanceQuery(`${base()}/agent-tree/status`, instanceId)
    ),

  getAgentTreeChildren: (parentAgentId: number | null, instanceId?: string | null) => {
    const params = new URLSearchParams();
    if (instanceId) params.set('instanceId', instanceId);
    if (parentAgentId != null) params.set('parentAgentId', String(parentAgentId));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return migGet<{ success: boolean; data: {
      rootBrokerId: number | null;
      rootLabel: string | null;
      parentAgentId: number | null;
      nodes: E123AgentTreeNode[];
    } }>(`${base()}/agent-tree/children${qs}`);
  },

  importAgentTree: (file: File, instanceId: string) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('instanceId', instanceId);
    return migPost<{ success: boolean; data: E123AgentTreeImportResult; message?: string }>(
      `${base()}/agent-tree/import`,
      formData,
      true
    );
  },

  getPayablesStatus: (instanceId?: string | null) =>
    migGet<{ success: boolean; data: E123PayablesSnapshotStatus }>(
      withInstanceQuery(`${base()}/payables/status`, instanceId)
    ),

  importPayables: (file: File, instanceId: string) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('instanceId', instanceId);
    return migPost<{ success: boolean; data: E123PayablesImportResult; message?: string }>(
      `${base()}/payables/import`,
      formData,
      true
    );
  },

  getGroupsListStatus: (instanceId?: string | null) =>
    migGet<{ success: boolean; data: E123GroupsListSnapshotStatus }>(
      withInstanceQuery(`${base()}/groups-list/status`, instanceId)
    ),

  importGroupsList: (file: File, instanceId: string) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('instanceId', instanceId);
    return migPost<{ success: boolean; data: E123GroupsListImportResult; message?: string }>(
      `${base()}/groups-list/import`,
      formData,
      true
    );
  },

  // --- Agent migration wizard (create AB365 agents from E123 tree) ---

  createAgentMigrationBatch: (body: {
    instanceId: string;
    rootBrokerId: number;
    rootAgentLabel?: string | null;
    includeDownline?: boolean;
    tenantId?: string | null;
    agencyId?: string | null;
    draftJson?: AgentMigrationDraftJson;
  }) =>
    migPost<MigResponse<AgentMigrationBatch>>(`${base()}/agents/migration/batches`, body),

  getAgentMigrationBatch: (batchId: string) =>
    migGet<MigResponse<AgentMigrationBatch>>(`${base()}/agents/migration/batches/${batchId}`),

  uploadAgentMigrationPayablesCsv: (batchId: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return migPost<MigResponse<AgentMigrationPayablesIndex>>(
      `${base()}/agents/migration/batches/${encodeURIComponent(batchId)}/payables-csv`,
      formData,
      true
    );
  },

  uploadAgentMigrationCommissionRoster: (batchId: string, file: File, tenantId?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    if (tenantId) formData.append('tenantId', tenantId);
    return migPost<MigResponse<{
      fileName?: string | null;
      rowCount?: number;
      matchedCount?: number;
      warnings?: string[];
    }>>(
      `${base()}/agents/migration/batches/${encodeURIComponent(batchId)}/commission-roster`,
      formData,
      true
    );
  },

  listAgentMigrationCommissionGroups: (tenantId: string) =>
    migGet<MigResponse<Array<{ commissionGroupId: string; name: string; status: string }>>>(
      `${base()}/agents/migration/tenants/${encodeURIComponent(tenantId)}/commission-groups`
    ),

  patchAgentMigrationBatch: (
    batchId: string,
    body: {
      tenantId?: string;
      agencyId?: string;
      wizardStep?: number;
      draftJson?: AgentMigrationDraftJson;
      rootAgentLabel?: string;
    }
  ) =>
    migPatch<MigResponse<{ batchId: string; tenantId: string; agencyId: string; wizardStep: number; status: string }>>(
      `${base()}/agents/migration/batches/${batchId}`,
      body
    ),

  listAgentMigrationAgencies: (tenantId: string) =>
    migGet<MigResponse<Array<{ agencyId: string; name: string; status: string }>>>(
      `${base()}/agents/migration/tenants/${encodeURIComponent(tenantId)}/agencies`
    ),

  getAgentMigrationCommissionLevels: (tenantId: string) =>
    migGet<MigResponse<Array<{
      commissionLevelId: string;
      displayName: string;
      sortOrder: number;
      legacyTierLevel?: number | null;
      isSystemSeeded?: boolean;
      isActive?: boolean;
    }>> & {
      meta?: {
        useCustomCommissionLevelsOnly?: boolean;
        commissionLevelsHybridEnabled?: boolean;
        totalLevelCount?: number;
        effectiveLevelCount?: number;
      };
    }>(`${base()}/agents/migration/tenants/${encodeURIComponent(tenantId)}/commission-levels`),

  getAgentMigrationWorkspace: (batchId: string) =>
    migGet<MigResponse<AgentMigrationWorkspace>>(
      `${base()}/agents/migration/workspace?batchId=${encodeURIComponent(batchId)}`,
      false,
      E123_AGENT_MIGRATION_WORKSPACE_POLL_TIMEOUT_MS
    ),

  startAgentMigrationWorkspaceBuild: (batchId: string, force = false) =>
    migPost<MigResponse<AgentMigrationWorkspaceBuildStatus>>(
      `${base()}/agents/migration/batches/${batchId}/build-workspace`,
      { force },
      true
    ),

  getAgentMigrationWorkspaceStatus: (batchId: string) =>
    migGet<MigResponse<AgentMigrationWorkspaceBuildStatus>>(
      `${base()}/agents/migration/batches/${batchId}/workspace-status`,
      false,
      E123_AGENT_MIGRATION_WORKSPACE_POLL_TIMEOUT_MS
    ),

  previewAgentMigration: (batchId: string) =>
    migPost<MigResponse<AgentMigrationPreviewResult>>(`${base()}/agents/migration/preview`, { batchId }, true),

  applyAgentMigration: (batchId: string, achByBrokerId?: Record<string, AgentMigrationAchPayload>) =>
    migPost<MigResponse<AgentMigrationApplyResult>>(
      `${base()}/agents/migration/apply`,
      { batchId, achByBrokerId },
      true
    ),

  fetchAgentMigrationBankAccount: (e123BrokerId: number, instanceId: string) =>
    migGet<MigResponse<AgentMigrationBankFetchResult>>(
      `${base()}/agents/migration/bank-accounts/${e123BrokerId}?instanceId=${encodeURIComponent(instanceId)}`
    ),

  // --- Group migration wizard (create AB365 groups from E123 groups list) ---

  createGroupMigrationBatch: (body: {
    instanceId: string;
    tenantId: string;
    rootBrokerId?: number | null;
    rootAgentLabel?: string | null;
    includeDownline?: boolean;
  }) =>
    migPost<MigResponse<GroupMigrationBatch>>(`${base()}/groups/migration/batches`, body),

  getGroupMigrationBatch: (batchId: string) =>
    migGet<MigResponse<GroupMigrationBatch>>(`${base()}/groups/migration/batches/${batchId}`),

  patchGroupMigrationBatch: (batchId: string, body: Record<string, unknown>) =>
    migPatch<MigResponse<{ batchId: string; wizardStep: number; status: string }>>(
      `${base()}/groups/migration/batches/${batchId}`,
      body
    ),

  detectGroupMigration: (batchId: string) =>
    migPost<MigResponse<GroupMigrationDetectResult>>(
      `${base()}/groups/migration/batches/${batchId}/detect`,
      {},
      true
    ),

  previewGroupMigration: (batchId: string) =>
    migGet<MigResponse<GroupMigrationPreviewResult>>(
      `${base()}/groups/migration/batches/${batchId}/preview`,
      true
    ),

  applyGroupMigration: (batchId: string, groups: Array<Record<string, unknown>>) =>
    migPost<MigResponse<GroupMigrationApplyResult>>(
      `${base()}/groups/migration/batches/${batchId}/apply`,
      { groups },
      true
    ),

  getGroupMigrationPrereqs: (instanceId?: string | null) =>
    migGet<{ success: boolean; data: { groupsListReady: boolean; agentTreeReady: boolean; agentMapReady: boolean; agentMapCount: number } }>(
      withInstanceQuery(`${base()}/groups/migration/prereqs`, instanceId)
    )
};

export interface AgentMigrationWorkspaceProgress {
  phase: string;
  processed: number;
  total: number;
  currentLabel?: string | null;
  currentBrokerId?: number | null;
  startedUtc?: string;
  updatedUtc?: string;
}

export interface AgentMigrationWorkspaceBuildStatus {
  status: 'idle' | 'building' | 'ready' | 'failed';
  progress: AgentMigrationWorkspaceProgress | null;
  workspace: AgentMigrationWorkspace | null;
  error: string | null;
  started?: boolean;
  cached?: boolean;
}

export interface AgentMigrationBatch {
  batchId: string;
  instanceId: string;
  rootBrokerId: number;
  rootAgentLabel: string | null;
  includeDownline: boolean;
  tenantId: string | null;
  agencyId: string | null;
  wizardStep: number;
  status: string;
  draftJson?: AgentMigrationDraftJson;
  summaryJson?: Record<string, unknown>;
}

export interface AgentMigrationImportSettings {
  /** When true (default), omit E123 brokers with no active enrolled members in their subtree. */
  excludeAgentsWithNoMembers?: boolean;
  /** When true (default), omit E123 brokers with no email on their E123 profile. */
  excludeAgentsWithoutEmail?: boolean;
}

export interface AgentMigrationDraftJson {
  importSettings?: AgentMigrationImportSettings;
  commissionRoster?: {
    fileName?: string | null;
    rowCount?: number;
    matchedCount?: number;
    warnings?: string[];
    byBrokerId?: Record<string, unknown>;
  };
  nodeOverrides?: Record<string, {
    tierLevel?: number;
    commissionGroupId?: string;
    linkedAgentId?: string;
    /** Link to an existing tenant user without an agent record (promote on apply). */
    linkedUserId?: string;
    /** agency:{uuid} or agent:{uuid} — upline for migration root in AB365 */
    parentAb365Id?: string;
    skipAch?: boolean;
    excluded?: boolean;
  }>;
}

export type AgentMigrationBrokerAction =
  | 'map_existing'
  | 'map_agency'
  | 'create_new'
  | 'promote_user'
  | 'conflict'
  | 'excluded';

export interface AgentMigrationTierMatchSample {
  payout: number;
  commissionableAmount: number;
  productId: number | null;
  productLabel: string | null;
  benefit: string | null;
  transactionId: string | null;
  matchedTierLevel: number;
  matchedTierLabel: string;
  matchedRuleName: string | null;
  expectedPayout: number;
  matchedByProduct?: boolean;
}

export interface AgentMigrationTierInference {
  suggestedTierLevel: number | null;
  suggestedTierLabel: string | null;
  confidence: 'none' | 'low' | 'medium' | 'high';
  matchCount: number;
  sampleCount: number;
  matches: AgentMigrationTierMatchSample[];
  commissionGroupId?: string | null;
  commissionGroupName?: string | null;
}

export interface AgentMigrationPayablesAgentRow {
  payeeAgentId: number;
  payeeLabel: string | null;
  achAvailable: boolean;
  ach: AgentMigrationAchPayload['ach'];
  sellerLineCount: number;
  overrideLineCount: number;
  tierInference: AgentMigrationTierInference;
}

export interface AgentMigrationPayablesIndex {
  fileName: string | null;
  rowCount: number;
  commProductRowCount: number;
  dominantMonth: string | null;
  dominantCount: number;
  monthCount: number;
  minPostedDate: string | null;
  maxPostedDate: string | null;
  warnings: string[];
  commissionGroupId: string | null;
  commissionGroupName: string | null;
  agentCount: number;
  agents: Record<string, AgentMigrationPayablesAgentRow>;
  uploadedUtc?: string;
}

export interface AgentMigrationBrokerNode {
  e123BrokerId: number;
  label: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  depth: number;
  parentE123BrokerId: number | null;
  parentLabel: string | null;
  action: AgentMigrationBrokerAction;
  matchStatus: string;
  matchMethod: string | null;
  conflictReason: string | null;
  existingAgentId: string | null;
  existingAgentName?: string | null;
  existingUserId?: string | null;
  existingTierLevel?: number | null;
  existingTierLabel?: string | null;
  mappedAgencyId?: string | null;
  tierLevel: number;
  defaultTierLevel: number;
  skipAch: boolean;
  missingParentInScope: boolean;
  uplineAb365AgentId: string | null;
  payablesAchAvailable?: boolean;
  payablesSellerLineCount?: number;
  payablesOverrideLineCount?: number;
  tierInference?: AgentMigrationTierInference;
  tierMatchLevel?: number | null;
  tierMatchLabel?: string | null;
  tierMatchConfidence?: 'none' | 'low' | 'medium' | 'high';
  suggestedTierFromPayables?: number;
  payablesInCsv?: boolean;
  suggestedCommissionGroupId?: string | null;
  suggestedCommissionGroupName?: string | null;
  rosterGroupName?: string | null;
  rosterTierLabel?: string | null;
  commissionGroupId?: string | null;
  payablesTierMatched?: boolean;
}

export interface AgentMigrationPayablesTierStats {
  tierableCount: number;
  matchedCount: number;
  lowConfidenceCount: number;
  noMatchCount: number;
  notInCsvCount: number;
  uplineOnlyCount: number;
}

export interface AgentMigrationWorkspace {
  batch: AgentMigrationBatch;
  brokers: AgentMigrationBrokerNode[];
  payables?: AgentMigrationPayablesIndex;
  payablesTierStats?: AgentMigrationPayablesTierStats;
  commissionRoster?: {
    fileName?: string | null;
    rowCount?: number;
    matchedCount?: number;
    rosterMatchedCount?: number;
  } | null;
  commissionGroups?: Array<{ commissionGroupId: string; name: string; status: string }>;
  tree: {
    rootBrokerId: number;
    root: AgentMigrationBrokerNode & { children?: unknown[] } | null;
    nodes: unknown[];
  };
  validation: {
    hasCycle: boolean;
    orphanCount: number;
    conflictCount: number;
    createCount: number;
    mapOnlyCount: number;
    excludedCount: number;
    excludeAgentsWithNoMembers?: boolean;
    excludeAgentsWithoutEmail?: boolean;
    noMembersExcludedCount?: number;
    noEmailExcludedCount?: number;
  };
}

export interface AgentMigrationPreviewResult {
  workspace: AgentMigrationWorkspace;
  summary: {
    totalBrokers: number;
    mapExisting: number;
    promoteUser: number;
    createNew: number;
    conflicts: number;
    excluded: number;
    missingParent: number;
    hasCycle: boolean;
    canApply: boolean;
  };
}

export interface AgentMigrationAchPayload {
  ach: {
    bankName: string | null;
    routingNumber: string;
    accountNumber: string;
    accountType: string;
    accountNumberLast4?: string;
  } | null;
  skip?: boolean;
}

export interface AgentMigrationBankFetchResult {
  available: boolean;
  ach: AgentMigrationAchPayload['ach'];
  reason: string | null;
  bankAccountId?: number;
}

export interface AgentMigrationApplyResult {
  summary: {
    appliedUtc: string;
    created: number;
    mapped: number;
    errors: number;
    results: Array<{
      e123BrokerId: number;
      action: string;
      agentId?: string;
      userId?: string;
      message?: string;
    }>;
  };
  results: unknown[];
  workspace: AgentMigrationWorkspace;
}

function workspacePhaseLabel(phase: string | undefined): string {
  switch (phase) {
    case 'starting':
      return 'Starting…';
    case 'loading_tree':
      return 'Loading agent tree from CSV…';
    case 'loading_e123_members':
      return 'Loading active E123 members…';
    case 'enriching_e123':
      return 'Fetching agent profiles from E123…';
    case 'classifying':
      return 'Matching agents in AB365…';
    case 'computing_tiers':
      return 'Computing upline tiers…';
    case 'complete':
      return 'Complete';
    case 'failed':
      return 'Failed';
    default:
      return phase || 'Working…';
  }
}

export { workspacePhaseLabel };

export async function waitForAgentMigrationWorkspace(
  batchId: string,
  onProgress?: (progress: AgentMigrationWorkspaceProgress | null) => void
): Promise<AgentMigrationWorkspace> {
  const startRes = await e123MigrationService.startAgentMigrationWorkspaceBuild(batchId);
  if (!startRes.success) {
    throw new Error(startRes.message || 'Failed to start workspace build');
  }
  if (startRes.data?.status === 'ready' && startRes.data.workspace) {
    onProgress?.(startRes.data.progress || { phase: 'complete', processed: 0, total: 0 });
    return startRes.data.workspace;
  }

  const startedAt = Date.now();
  let lastProcessed = -1;
  let lastProgressAt = Date.now();

  while (Date.now() - startedAt < E123_AGENT_MIGRATION_WORKSPACE_MAX_WAIT_MS) {
    const statusRes = await e123MigrationService.getAgentMigrationWorkspaceStatus(batchId);
    if (!statusRes.success || !statusRes.data) {
      throw new Error(statusRes.message || 'Failed to read workspace build status');
    }
    const { status, progress, workspace, error } = statusRes.data;
    onProgress?.(progress || null);

    if (status === 'ready' && workspace) return workspace;
    if (status === 'failed') {
      throw new Error(error || 'Workspace build failed');
    }

    const processed = progress?.processed ?? 0;
    if (processed > lastProcessed) {
      lastProcessed = processed;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > E123_AGENT_MIGRATION_WORKSPACE_STALE_MS) {
      throw new Error(
        'Workspace build stalled (no progress for 20 minutes). Check server logs for [agent-migration-workspace].'
      );
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error('Workspace build timed out after 3 hours');
}

// --- Group Migration types ---

export interface GroupMigrationBatch {
  batchId: string;
  instanceId: string;
  tenantId: string | null;
  wizardStep: number;
  status: string;
  rootBrokerId?: number | null;
  rootAgentLabel?: string | null;
  includeDownline?: boolean;
  createdUtc?: string;
  modifiedUtc?: string;
}

export type GroupMigrationBrokerAction =
  | 'create_new'
  | 'map_existing'
  | 'already_mapped'
  | 'conflict'
  | 'excluded';

export interface GroupMigrationDetectedGroup {
  e123BrokerId: number;
  label: string;
  email: string | null;
  contactName: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  taxId?: string | null;
  address?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  memberCount: number;
  action: GroupMigrationBrokerAction;
  excludeReason?: string | null;
  exclusionMessage?: string | null;
  isEmployerGroup?: boolean;
  matchStatus: string;
  conflictReason: string | null;
  existingGroupId: string | null;
  existingGroupName: string | null;
  agentMapped: boolean;
  agentId: string | null;
  agentName: string | null;
  agentMatchStatus: string | null;
}

export interface GroupMigrationDetectResult {
  groups: GroupMigrationDetectedGroup[];
  summary: {
    total: number;
    inScopeTotal?: number;
    outsideDownlineCount?: number;
    rootBrokerId?: number;
    rootAgentLabel?: string | null;
    includeDownline?: boolean;
    employerGroups?: number;
    createNew: number;
    mapExisting: number;
    alreadyMapped: number;
    conflicts: number;
    excluded: number;
    excludedNonEmployer?: number;
    excludedAgentUnmapped?: number;
    agentMappedCount: number;
    agentUnmappedCount: number;
  };
}

export interface GroupMigrationPreviewRow {
  e123BrokerId: number;
  label: string;
  action: string;
  message: string;
  memberCount: number;
  conflictCount: number;
  conflictDetails?: Array<{
    memberId: string;
    memberName: string;
    reason: string;
  }>;
}

export interface GroupMigrationPreviewResult {
  rows: GroupMigrationPreviewRow[];
  total: number;
  summary: {
    createCount: number;
    mapCount: number;
    skipCount: number;
    conflictCount: number;
    errorCount: number;
  };
  canApply: boolean;
}

export interface GroupMigrationApplyResult {
  summary: {
    appliedUtc: string;
    created: number;
    mapped: number;
    skipped: number;
    errors: number;
  };
  results: Array<{
    e123BrokerId: number;
    label: string;
    action: string;
    groupId?: string;
    message?: string;
  }>;
}
