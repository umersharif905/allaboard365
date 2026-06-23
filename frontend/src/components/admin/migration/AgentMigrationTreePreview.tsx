import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SearchableDropdown from '../../common/SearchableDropdown';
import type {
  AgentMigrationBrokerNode,
  AgentMigrationDraftJson,
  AgentMigrationWorkspace,
  TenantAgentSearchResult
} from '../../../services/e123Migration.service';
import { e123MigrationService } from '../../../services/e123Migration.service';

type LinkDropdownOption = {
  id: string;
  value: string;
  label: string;
  email?: string;
  code?: string;
  sublabel?: string;
};

function mapSearchResultToLinkOption(result: TenantAgentSearchResult): LinkDropdownOption {
  const isUser = result.linkType === 'user' || (!result.agentId && !!result.userId);
  const value = isUser ? `user:${result.userId}` : String(result.agentId || '');
  return {
    id: value,
    value,
    label: result.displayName,
    email: result.email || undefined,
    code: result.agentCode || undefined,
    sublabel: result.hint || (isUser ? 'Existing user — will add agent role' : undefined)
  };
}

function mergeLinkOptions(...lists: Array<LinkDropdownOption[] | undefined>): LinkDropdownOption[] {
  const seen = new Set<string>();
  const out: LinkDropdownOption[] = [];
  for (const list of lists) {
    for (const option of list || []) {
      if (!option.value || seen.has(option.value)) continue;
      seen.add(option.value);
      out.push(option);
    }
  }
  return out;
}

function resolveBrokerLinkValue(
  broker: AgentMigrationBrokerNode | undefined,
  draftJson: AgentMigrationDraftJson,
  brokerId: number
): string {
  const override = getNodeOverride(draftJson, brokerId);
  if (override.linkedAgentId) return override.linkedAgentId;
  if (override.linkedUserId) return `user:${override.linkedUserId}`;
  if (broker?.existingAgentId) return broker.existingAgentId;
  if (broker?.existingUserId) return `user:${broker.existingUserId}`;
  return '';
}

export type AgentMigrationTierOption = {
  level: number;
  label: string;
  commissionLevelId?: string;
};

interface Props {
  workspace: AgentMigrationWorkspace;
  draftJson: AgentMigrationDraftJson;
  onDraftChange: (draft: AgentMigrationDraftJson) => void;
  tierOptions: AgentMigrationTierOption[];
  tiersLoading?: boolean;
  tierOptionsMeta?: {
    useCustomCommissionLevelsOnly?: boolean;
    effectiveLevelCount?: number;
  } | null;
  tiersError?: string | null;
  tiersFromTenantApi?: boolean;
  tiersLoadedForTenantId?: string | null;
  selectedTenantId?: string | null;
  tenantName?: string;
  batchId?: string | null;
  instanceId?: string | null;
  defaultAgencyId?: string | null;
  agencies?: Array<{ agencyId: string; name: string }>;
  onRosterUploaded?: () => void;
  onWorkspaceRebuild?: (draft?: AgentMigrationDraftJson) => void | Promise<void>;
  onRefreshPreview?: () => void | Promise<void>;
}

/** Agent | ID | Match | Commission group | Hierarchy | Bank | Include */
const GRID_COLS =
  'xl:grid-cols-[minmax(10rem,1.35fr)_4.5rem_minmax(7.5rem,0.85fr)_minmax(11rem,1.15fr)_minmax(8.5rem,0.9fr)_minmax(4.5rem,0.5fr)_3rem]';

function getNodeOverride(draftJson: AgentMigrationDraftJson, brokerId: number) {
  return draftJson.nodeOverrides?.[brokerId] || draftJson.nodeOverrides?.[String(brokerId)] || {};
}

function brokerCanToggleInclude(
  broker: AgentMigrationBrokerNode | undefined,
  action?: AgentMigrationBrokerNode['action']
): boolean {
  const act = broker?.action ?? action;
  return act !== 'conflict' && act !== 'excluded';
}

function isBrokerIncluded(
  draftJson: AgentMigrationDraftJson,
  brokerId: number,
  broker?: AgentMigrationBrokerNode
): boolean {
  if (!brokerCanToggleInclude(broker)) return false;
  return !getNodeOverride(draftJson, brokerId).excluded;
}

function collectDescendantIds(node: TreeChild): number[] {
  const ids: number[] = [];
  for (const child of node.children || []) {
    ids.push(child.e123BrokerId);
    ids.push(...collectDescendantIds(child));
  }
  return ids;
}

function buildAgencyUplineOptions(agencies: Array<{ agencyId: string; name: string }>) {
  return agencies.map((agency) => ({
    id: `agency:${agency.agencyId}`,
    value: `agency:${agency.agencyId}`,
    label: agency.name,
    sublabel: 'Agency',
    section: 'agency'
  }));
}

function buildUplineOptions(
  agencies: Array<{ agencyId: string; name: string }>,
  agentSearchOptions: Array<{ id: string; value: string; label: string; email?: string }>,
  parentAb365Id: string,
  selectedAgentLabel?: string | null
) {
  const agencyOpts = buildAgencyUplineOptions(agencies);
  const agentOpts = agentSearchOptions.map((agent) => ({
    id: `agent:${agent.value}`,
    value: `agent:${agent.value}`,
    label: agent.label,
    email: agent.email,
    sublabel: 'Agent',
    section: 'agent'
  }));
  if (parentAb365Id.startsWith('agent:') && !agentOpts.some((opt) => opt.value === parentAb365Id)) {
    agentOpts.unshift({
      id: parentAb365Id,
      value: parentAb365Id,
      label: selectedAgentLabel || 'Selected agent',
      email: undefined,
      sublabel: 'Agent',
      section: 'agent'
    });
  }
  return [...agencyOpts, ...agentOpts];
}

function BrokerNameCell({
  label,
  email
}: {
  label: string;
  email?: string | null;
}) {
  return (
    <div className="min-w-0 flex-1">
      <span className="font-medium text-gray-900 truncate block" title={label}>
        {label}
      </span>
      {email ? (
        <span className="text-[11px] text-gray-500 truncate block" title={email}>
          {email}
        </span>
      ) : null}
    </div>
  );
}

function displayBrokerAction(action: AgentMigrationBrokerNode['action'] | undefined) {
  if (action === 'map_agency') return 'create_new';
  return action;
}

function actionBadge(action: AgentMigrationBrokerNode['action']) {
  switch (displayBrokerAction(action)) {
    case 'map_existing':
      return <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-50 text-green-800 border border-green-200">Existing</span>;
    // NOTE: 'map_agency' is remapped to 'create_new' by displayBrokerAction() above, so it
    // renders the "New" badge — matching current (staging-tested) behavior. The dedicated
    // "Agency" badge is unreachable; if it should show, change the switch to use raw `action`.
    case 'create_new':
      return <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-800 border border-blue-200">New</span>;
    case 'promote_user':
      return <span className="text-[11px] px-2 py-0.5 rounded-full bg-violet-50 text-violet-800 border border-violet-200">Add role</span>;
    case 'conflict':
      return <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-50 text-red-900 border border-red-200">Conflict</span>;
    case 'excluded':
      return <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-50 text-gray-600 border border-gray-200">Excluded</span>;
    default:
      return null;
  }
}

function conflictDetail(broker: AgentMigrationBrokerNode): string {
  switch (broker.conflictReason) {
    case 'email_exists_other_tenant':
      return 'Email is on a user in another tenant — resolve before apply.';
    case 'saved_map_cross_tenant':
      return 'Saved E123 map points to an agent in another tenant.';
    case 'manual_link_cross_tenant':
      return 'Selected AB365 agent is in another tenant.';
    default:
      return broker.conflictReason || 'Blocks apply until resolved.';
  }
}

function tierLabelForLevel(level: number, tierOptions: AgentMigrationTierOption[]) {
  const match = tierOptions.find((t) => t.level === level);
  if (match) return match.label.replace(/^Level\s[\d.-]+:\s*/, '') || match.label;
  return `Level ${level}`;
}

function Ab365LinkCell({
  broker,
  brokerId,
  draftJson,
  isRoot,
  tenantId,
  instanceId,
  agencies,
  parentAb365Id,
  linkOptions,
  tenantLinkPool,
  uplineOptions,
  linkSearchLoading,
  uplineSearchLoading,
  linkSaving,
  onLinkSearch,
  onUplineSearch,
  onLinkAgent,
  onParentChange
}: {
  broker: AgentMigrationBrokerNode | undefined;
  brokerId: number;
  draftJson: AgentMigrationDraftJson;
  isRoot: boolean;
  tenantId: string | null;
  instanceId: string | null;
  agencies: Array<{ agencyId: string; name: string }>;
  parentAb365Id: string;
  linkOptions: LinkDropdownOption[];
  tenantLinkPool: LinkDropdownOption[];
  uplineOptions: Array<{ id: string; value: string; label: string; email?: string; code?: string; sublabel?: string; section?: string }>;
  linkSearchLoading: boolean;
  uplineSearchLoading: boolean;
  linkSaving: boolean;
  onLinkSearch: (query: string) => void;
  onUplineSearch: (query: string) => void;
  onLinkAgent: (linkValue: string, linkLabel: string) => void;
  onParentChange: (parentRef: string) => void;
}) {
  if (!broker) return <span className="text-xs text-gray-400">—</span>;

  const linkedId = resolveBrokerLinkValue(broker, draftJson, brokerId);
  const canLink = broker.action !== 'conflict' && broker.action !== 'excluded' && !!tenantId && !!instanceId;
  const linkedSeed = linkedId
    ? [{
      id: linkedId,
      value: linkedId,
      label: broker.existingAgentName || broker.label || 'Linked',
      email: broker.email || undefined,
      sublabel: linkedId.startsWith('user:') ? 'Existing user — will add agent role' : undefined
    }]
    : [];
  const linkDropdownOptions = mergeLinkOptions(linkOptions, linkedSeed, tenantLinkPool);

  const matchHint = broker.matchMethod === 'email'
    ? 'Auto-matched on email'
    : broker.matchMethod === 'name'
      ? 'Auto-matched on name'
      : broker.matchMethod === 'saved'
        ? 'Saved E123 map'
        : null;

  return (
    <div className="space-y-1.5 min-w-0">
      {actionBadge(broker.action)}
      {displayBrokerAction(broker.action) === 'promote_user' ? (
        <p className="text-[11px] text-violet-800 leading-snug">Will create agent + link existing user</p>
      ) : null}
      {displayBrokerAction(broker.action) === 'create_new' ? (
        <p className="text-[11px] text-blue-800 leading-snug">New user + agent</p>
      ) : null}
      {broker.action === 'map_existing' && matchHint ? (
        <p className="text-[11px] text-green-800 leading-snug">{matchHint}</p>
      ) : null}
      {broker.action === 'conflict' ? (
        <p className="text-[11px] text-red-800 leading-snug font-medium">{conflictDetail(broker)}</p>
      ) : null}
      {canLink ? (
        <>
          <SearchableDropdown
            options={linkDropdownOptions}
            value={linkedId}
            onChange={(value, label) => {
              if (value) onLinkAgent(value, label);
            }}
            placeholder="Link to agent"
            searchPlaceholder="Name, email, or code"
            loading={linkSaving || linkSearchLoading}
            disabled={linkSaving}
            showEmail
            showCode
            showSublabel
            useBackendSearch
            onSearch={onLinkSearch}
            className="min-w-0"
          />
          {!linkSearchLoading && linkDropdownOptions.length === 0 ? (
            <p className="text-[10px] text-gray-500 leading-snug">Type a name or email to search tenant users and agents</p>
          ) : null}
        </>
      ) : null}
      {isRoot && canLink ? (
        <div className="space-y-1">
          <label className="text-[10px] text-gray-500 block">Reports to</label>
          <SearchableDropdown
            options={uplineOptions}
            value={parentAb365Id}
            onChange={(value) => {
              if (value) onParentChange(value);
            }}
            placeholder="Agency or agent upline"
            searchPlaceholder="Search agent upline"
            loading={uplineSearchLoading}
            showSublabel
            useBackendSearch
            onSearch={onUplineSearch}
            sectionLabels={{ agency: 'Agencies', agent: 'Agents' }}
            className="min-w-0"
          />
        </div>
      ) : null}
    </div>
  );
}

function BankHintCell({ broker }: { broker: AgentMigrationBrokerNode | undefined }) {
  if (!broker || broker.action === 'excluded') {
    return <span className="text-xs text-gray-400">—</span>;
  }
  if (broker.payablesAchAvailable) {
    return <span className="text-[11px] text-emerald-800">Yes</span>;
  }
  if (broker.payablesInCsv) {
    return <span className="text-[11px] text-gray-500">No</span>;
  }
  return <span className="text-[11px] text-gray-400">—</span>;
}

function CommissionGroupSelect({
  broker,
  groupOptions,
  groupSelectValue,
  onGroupChange
}: {
  broker: AgentMigrationBrokerNode | undefined;
  groupOptions: Array<{ commissionGroupId: string; name: string }>;
  groupSelectValue: string;
  onGroupChange: (groupId: string) => void;
}) {
  const showPayablesMismatch = broker?.payablesInCsv
    && (broker.payablesSellerLineCount ?? 0) > 0
    && !broker.payablesTierMatched;

  return (
    <div className="min-w-0 w-full">
      <select
        className="rounded-md border border-gray-300 px-2 py-1.5 text-sm w-full bg-white"
        value={groupSelectValue}
        onChange={(e) => onGroupChange(e.target.value)}
        aria-label="Commission group"
      >
        <option value="">— Select group —</option>
        {groupOptions.map((g) => (
          <option key={g.commissionGroupId} value={g.commissionGroupId}>
            {g.name}
          </option>
        ))}
      </select>
      {broker?.suggestedCommissionGroupName && groupSelectValue === (broker.suggestedCommissionGroupId || '') ? (
        <p className="text-[10px] text-gray-600 mt-1 truncate" title="Payout tier within this commission group (from roster)">
          Payout tier
          {broker.rosterTierLabel ? ` · ${broker.rosterTierLabel}` : ''}
        </p>
      ) : null}
      {showPayablesMismatch ? (
        <p className="text-[10px] text-amber-800 mt-1">Past payables do not match</p>
      ) : null}
    </div>
  );
}

function ExistingCommissionTierReadonly({
  broker,
  tierOptions
}: {
  broker: AgentMigrationBrokerNode | undefined;
  tierOptions: AgentMigrationTierOption[];
}) {
  if (!broker) return <span className="text-xs text-gray-400">—</span>;
  const level = broker.existingTierLevel ?? broker.tierLevel;
  const label = broker.existingTierLabel
    || tierOptions.find((t) => t.level === level)?.label
    || (level != null ? `Level ${level}` : null);
  if (label == null) return <span className="text-xs text-gray-400">—</span>;
  return (
    <span
      className="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-md px-2 py-1.5 block truncate"
      title="Current tier in AB365 (read-only)"
    >
      {label}
    </span>
  );
}

function CommissionTierSelect({
  broker,
  tierOptions,
  tiersLoading,
  tierSelectValue,
  onTierChange
}: {
  broker: AgentMigrationBrokerNode | undefined;
  tierOptions: AgentMigrationTierOption[];
  tiersLoading?: boolean;
  tierSelectValue: number;
  onTierChange: (tier: number) => void;
}) {
  const suggested = broker?.suggestedTierFromPayables;

  return (
    <div className="min-w-0 w-full">
      <select
        className="rounded-md border border-gray-300 px-2.5 py-1.5 text-sm w-full bg-white"
        value={tierSelectValue}
        disabled={tiersLoading || tierOptions.length === 0}
        onChange={(e) => onTierChange(Number(e.target.value))}
        aria-label="Commission tier"
      >
        {tierOptions.length === 0 ? (
          <option value={tierSelectValue}>…</option>
        ) : (
          tierOptions.map((t) => (
            <option key={t.commissionLevelId || `${t.level}-${t.label}`} value={t.level}>
              {t.label}
            </option>
          ))
        )}
      </select>
      {suggested != null && tierSelectValue !== suggested ? (
        <p className="text-[10px] text-amber-800 mt-1 truncate" title="Payables inference differs from selection">
          Payables suggest: {tierLabelForLevel(suggested, tierOptions)}
        </p>
      ) : null}
    </div>
  );
}

type TreeChild = {
  e123BrokerId: number;
  label: string;
  action: AgentMigrationBrokerNode['action'];
  matchStatus: string;
  tierLevel: number;
  children?: TreeChild[];
};

function TreeNodeRow({
  node,
  brokerById,
  rootBrokerId,
  depth,
  draftJson,
  tierOptions,
  groupOptions,
  tiersLoading,
  tenantId,
  instanceId,
  defaultAgencyId,
  agencies,
  linkOptionsByBroker,
  tenantLinkPool,
  uplineOptionsByBroker,
  linkSearchLoadingBrokerId,
  uplineSearchLoadingBrokerId,
  linkSavingBrokerId,
  onLinkSearch,
  onUplineSearch,
  onLinkAgent,
  onParentChange,
  onTierChange,
  onGroupChange,
  onToggleInclude
}: {
  node: TreeChild;
  brokerById: Map<number, AgentMigrationBrokerNode>;
  rootBrokerId: number;
  depth: number;
  draftJson: AgentMigrationDraftJson;
  tierOptions: AgentMigrationTierOption[];
  groupOptions: Array<{ commissionGroupId: string; name: string }>;
  tiersLoading?: boolean;
  tenantId: string | null;
  instanceId: string | null;
  defaultAgencyId: string | null;
  agencies: Array<{ agencyId: string; name: string }>;
  linkOptionsByBroker: Record<number, LinkDropdownOption[]>;
  tenantLinkPool: LinkDropdownOption[];
  uplineOptionsByBroker: Record<number, Array<{ id: string; value: string; label: string; email?: string; sublabel?: string; section?: string }>>;
  linkSearchLoadingBrokerId: number | null;
  uplineSearchLoadingBrokerId: number | null;
  linkSavingBrokerId: number | null;
  onLinkSearch: (brokerId: number, query: string) => void;
  onUplineSearch: (brokerId: number, query: string) => void;
  onLinkAgent: (brokerId: number, linkValue: string, linkLabel: string) => void;
  onParentChange: (brokerId: number, parentRef: string) => void;
  onTierChange: (brokerId: number, tier: number) => void;
  onGroupChange: (brokerId: number, groupId: string) => void;
  onToggleInclude: (brokerId: number, included: boolean, cascadeBrokerIds?: number[]) => void;
}) {
  const broker = brokerById.get(node.e123BrokerId);
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = (node.children?.length || 0) > 0;
  const override = getNodeOverride(draftJson, node.e123BrokerId);
  const canToggleInclude = brokerCanToggleInclude(broker, node.action);
  const included = isBrokerIncluded(draftJson, node.e123BrokerId, broker);
  const showFields = included && canToggleInclude;

  const tierValue = broker?.tierLevel ?? node.tierLevel;
  const tierSelectValue = tierOptions.some((t) => t.level === tierValue)
    ? tierValue
    : tierOptions[0]?.level ?? tierValue;

  const groupSelectValue = override?.commissionGroupId
    || broker?.commissionGroupId
    || broker?.suggestedCommissionGroupId
    || '';

  const isRoot = node.e123BrokerId === rootBrokerId;
  const parentAb365Id = override?.parentAb365Id
    || (defaultAgencyId ? `agency:${defaultAgencyId}` : '');
  const uplineOptions = isRoot
    ? (uplineOptionsByBroker[node.e123BrokerId]
      || buildUplineOptions(agencies, [], parentAb365Id))
    : [];

  return (
    <div>
      <div
        className={`grid grid-cols-1 ${GRID_COLS} gap-x-3 gap-y-2 items-start py-2.5 text-sm border-b border-gray-100 ${
          canToggleInclude && !included ? 'opacity-55' : ''
        }`}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        <div className="flex items-start gap-1 min-w-0">
          {hasChildren ? (
            <button type="button" onClick={() => setExpanded((v) => !v)} className="shrink-0 text-gray-500 mt-0.5">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <BrokerNameCell label={node.label} email={broker?.email} />
            {broker?.missingParentInScope ? (
              <span className="text-[11px] text-amber-700 flex items-center gap-1 mt-0.5">
                <AlertTriangle className="h-3 w-3 shrink-0" /> Missing parent in scope
              </span>
            ) : null}
          </div>
        </div>

        <span className="text-xs text-gray-400 font-mono pt-1">{node.e123BrokerId}</span>

        <div className="pt-0.5">
          <Ab365LinkCell
            broker={broker}
            brokerId={node.e123BrokerId}
            draftJson={draftJson}
            isRoot={isRoot}
            tenantId={tenantId}
            instanceId={instanceId}
            agencies={agencies}
            parentAb365Id={parentAb365Id}
            linkOptions={linkOptionsByBroker[node.e123BrokerId] || []}
            tenantLinkPool={tenantLinkPool}
            uplineOptions={uplineOptions}
            linkSearchLoading={linkSearchLoadingBrokerId === node.e123BrokerId}
            uplineSearchLoading={uplineSearchLoadingBrokerId === node.e123BrokerId}
            linkSaving={linkSavingBrokerId === node.e123BrokerId}
            onLinkSearch={(query) => onLinkSearch(node.e123BrokerId, query)}
            onUplineSearch={(query) => onUplineSearch(node.e123BrokerId, query)}
            onLinkAgent={(linkValue, linkLabel) => onLinkAgent(node.e123BrokerId, linkValue, linkLabel)}
            onParentChange={(parentRef) => onParentChange(node.e123BrokerId, parentRef)}
          />
        </div>

        <div className="pt-0.5 min-w-0">
          {showFields ? (
            <CommissionGroupSelect
              broker={broker}
              groupOptions={groupOptions}
              groupSelectValue={groupSelectValue}
              onGroupChange={(groupId) => onGroupChange(node.e123BrokerId, groupId)}
            />
          ) : (
            <span className="text-xs text-gray-400">—</span>
          )}
        </div>

        <div className="pt-0.5 min-w-0">
          {showFields ? (
            <CommissionTierSelect
              broker={broker}
              tierOptions={tierOptions}
              tiersLoading={tiersLoading}
              tierSelectValue={tierSelectValue}
              onTierChange={(tier) => onTierChange(node.e123BrokerId, tier)}
            />
          ) : (
            <span className="text-xs text-gray-400">—</span>
          )}
        </div>

        <div className="pt-0.5">
          <BankHintCell broker={broker} />
        </div>

        <div className="flex justify-center pt-1">
          {canToggleInclude ? (
            <label className="inline-flex items-center" title={included ? 'Included in import' : 'Not included'}>
              <span className="sr-only">Include in import</span>
              <input
                type="checkbox"
                checked={included}
                onChange={(e) => {
                  const cascadeIds = e.target.checked ? collectDescendantIds(node) : [];
                  onToggleInclude(node.e123BrokerId, e.target.checked, cascadeIds);
                }}
                className="rounded border-gray-300"
              />
            </label>
          ) : (
            <span className="text-xs text-gray-400">—</span>
          )}
        </div>
      </div>

      {expanded && hasChildren
        ? node.children!.map((child) => (
            <TreeNodeRow
              key={child.e123BrokerId}
              node={child}
              brokerById={brokerById}
              rootBrokerId={rootBrokerId}
              depth={depth + 1}
              draftJson={draftJson}
              tierOptions={tierOptions}
              groupOptions={groupOptions}
              tiersLoading={tiersLoading}
              tenantId={tenantId}
              instanceId={instanceId}
              defaultAgencyId={defaultAgencyId}
              agencies={agencies}
              linkOptionsByBroker={linkOptionsByBroker}
              tenantLinkPool={tenantLinkPool}
              uplineOptionsByBroker={uplineOptionsByBroker}
              linkSearchLoadingBrokerId={linkSearchLoadingBrokerId}
              uplineSearchLoadingBrokerId={uplineSearchLoadingBrokerId}
              linkSavingBrokerId={linkSavingBrokerId}
              onLinkSearch={onLinkSearch}
              onUplineSearch={onUplineSearch}
              onLinkAgent={onLinkAgent}
              onParentChange={onParentChange}
              onTierChange={onTierChange}
              onGroupChange={onGroupChange}
              onToggleInclude={onToggleInclude}
            />
          ))
        : null}
    </div>
  );
}

export default function AgentMigrationTreePreview({
  workspace,
  draftJson,
  onDraftChange,
  tierOptions,
  tiersLoading = false,
  tierOptionsMeta = null,
  tiersError = null,
  tiersFromTenantApi = false,
  tiersLoadedForTenantId = null,
  selectedTenantId = null,
  tenantName = '',
  batchId = null,
  instanceId = null,
  defaultAgencyId = null,
  agencies = [],
  onRosterUploaded,
  onWorkspaceRebuild,
  onRefreshPreview
}: Props) {
  const rosterInputRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [rosterUploading, setRosterUploading] = useState(false);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [linkOptionsByBroker, setLinkOptionsByBroker] = useState<Record<number, LinkDropdownOption[]>>({});
  const [tenantLinkPool, setTenantLinkPool] = useState<LinkDropdownOption[]>([]);
  const [uplineAgentSearchByBroker, setUplineAgentSearchByBroker] = useState<
    Record<number, Array<{ id: string; value: string; label: string; email?: string; code?: string }>>
  >({});
  const [linkSearchLoadingBrokerId, setLinkSearchLoadingBrokerId] = useState<number | null>(null);
  const [uplineSearchLoadingBrokerId, setUplineSearchLoadingBrokerId] = useState<number | null>(null);
  const [linkSavingBrokerId, setLinkSavingBrokerId] = useState<number | null>(null);

  const rootBrokerId = workspace.tree?.rootBrokerId ?? workspace.batch?.rootBrokerId;

  const uplineOptionsByBroker = useMemo(() => {
    if (rootBrokerId == null) return {};
    const override = getNodeOverride(draftJson, rootBrokerId);
    const parentAb365Id = override.parentAb365Id || (defaultAgencyId ? `agency:${defaultAgencyId}` : '');
    const rootBroker = workspace.brokers.find((b) => b.e123BrokerId === rootBrokerId);
    return {
      [rootBrokerId]: buildUplineOptions(
        agencies,
        uplineAgentSearchByBroker[rootBrokerId] || [],
        parentAb365Id,
        rootBroker?.existingAgentName
      )
    };
  }, [agencies, defaultAgencyId, draftJson, rootBrokerId, uplineAgentSearchByBroker, workspace.brokers]);

  const groupOptions = useMemo(
    () => workspace.commissionGroups || [],
    [workspace.commissionGroups]
  );
  const tenantMismatch =
    Boolean(selectedTenantId && tiersLoadedForTenantId)
    && `${selectedTenantId}`.toLowerCase() !== `${tiersLoadedForTenantId}`.toLowerCase();
  const brokerById = useMemo(
    () => new Map(workspace.brokers.map((b) => [b.e123BrokerId, b])),
    [workspace.brokers]
  );

  const treeRoot = workspace.tree?.root as (TreeChild & { children?: TreeChild[] }) | null;
  const conflictCount = workspace.validation.conflictCount;

  const importableBrokers = useMemo(
    () => workspace.brokers.filter((b) => brokerCanToggleInclude(b)),
    [workspace.brokers]
  );
  const includedCount = useMemo(
    () => importableBrokers.filter((b) => isBrokerIncluded(draftJson, b.e123BrokerId, b)).length,
    [importableBrokers, draftJson]
  );
  const allIncluded = importableBrokers.length > 0 && includedCount === importableBrokers.length;
  const noneIncluded = includedCount === 0;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = !allIncluded && !noneIncluded && importableBrokers.length > 0;
    }
  }, [allIncluded, noneIncluded, importableBrokers.length]);

  const handleToggleInclude = useCallback((
    brokerId: number,
    included: boolean,
    cascadeBrokerIds: number[] = []
  ) => {
    const targetIds = included
      ? [brokerId, ...cascadeBrokerIds]
      : [brokerId];
    const uniqueIds = [...new Set(targetIds)];
    const nextOverrides = { ...draftJson.nodeOverrides };

    for (const id of uniqueIds) {
      const broker = workspace.brokers.find((b) => b.e123BrokerId === id);
      if (!brokerCanToggleInclude(broker)) continue;
      const prev = getNodeOverride(draftJson, id);
      if (included) {
        const next = { ...prev };
        delete next.excluded;
        if (Object.keys(next).length) nextOverrides[id] = next;
        else delete nextOverrides[id];
      } else {
        nextOverrides[id] = { ...prev, excluded: true };
      }
    }

    onDraftChange({ ...draftJson, nodeOverrides: nextOverrides });
  }, [draftJson, onDraftChange, workspace.brokers]);

  const handleSelectAllInclude = useCallback((included: boolean) => {
    const nextOverrides = { ...draftJson.nodeOverrides };
    for (const broker of importableBrokers) {
      const id = broker.e123BrokerId;
      const prev = getNodeOverride(draftJson, id);
      if (included) {
        const next = { ...prev };
        delete next.excluded;
        if (Object.keys(next).length) nextOverrides[id] = next;
        else delete nextOverrides[id];
      } else {
        nextOverrides[id] = { ...prev, excluded: true };
      }
    }
    onDraftChange({ ...draftJson, nodeOverrides: nextOverrides });
  }, [draftJson, importableBrokers, onDraftChange]);

  const handleTierChange = (brokerId: number, tierLevel: number) => {
    onDraftChange({
      ...draftJson,
      nodeOverrides: {
        ...draftJson.nodeOverrides,
        [brokerId]: {
          ...(draftJson.nodeOverrides?.[brokerId] || draftJson.nodeOverrides?.[String(brokerId)]),
          tierLevel
        }
      }
    });
  };

  const handleGroupChange = (brokerId: number, commissionGroupId: string) => {
    onDraftChange({
      ...draftJson,
      nodeOverrides: {
        ...draftJson.nodeOverrides,
        [brokerId]: {
          ...(draftJson.nodeOverrides?.[brokerId] || draftJson.nodeOverrides?.[String(brokerId)]),
          commissionGroupId: commissionGroupId || undefined
        }
      }
    });
  };

  const handleRosterUpload = async (file: File) => {
    if (!batchId) return;
    setRosterUploading(true);
    setRosterError(null);
    try {
      const res = await e123MigrationService.uploadAgentMigrationCommissionRoster(
        batchId,
        file,
        selectedTenantId || undefined
      );
      if (!res.success) throw new Error(res.message || 'Upload failed');
      if (res.data) {
        onDraftChange({
          ...draftJson,
          commissionRoster: res.data
        });
      }
      onRosterUploaded?.();
    } catch (err) {
      setRosterError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setRosterUploading(false);
    }
  };

  const rosterInfo = workspace.commissionRoster || draftJson.commissionRoster;

  const mapSearchResults = useCallback((results: TenantAgentSearchResult[]) => (
    results.map(mapSearchResultToLinkOption).filter((option) => !!option.value)
  ), []);

  const searchTenantAgentsForBroker = useCallback(async (
    brokerId: number,
    query: string,
    target: 'link' | 'upline'
  ) => {
    if (!selectedTenantId) return;
    const setLoading = target === 'link' ? setLinkSearchLoadingBrokerId : setUplineSearchLoadingBrokerId;
    const setOptions = target === 'link' ? setLinkOptionsByBroker : setUplineAgentSearchByBroker;
    setLoading(brokerId);
    try {
      const res = await e123MigrationService.searchTenantAgents(selectedTenantId, query, 40);
      if (res.success && res.data) {
        const mapped = target === 'upline'
          ? mapSearchResults(res.data.filter((row) => row.linkType !== 'user' && row.agentId))
          : mapSearchResults(res.data);
        setOptions((prev) => ({
          ...prev,
          [brokerId]: mapped
        }));
        if (target === 'link' && !query.trim()) {
          setTenantLinkPool((prev) => mergeLinkOptions(prev, mapped));
        }
      }
    } finally {
      setLoading(null);
    }
  }, [mapSearchResults, selectedTenantId]);

  const preloadTenantLinkPool = useCallback(async () => {
    if (!selectedTenantId) {
      setTenantLinkPool([]);
      return;
    }
    try {
      const res = await e123MigrationService.searchTenantAgents(selectedTenantId, '', 40);
      if (res.success && res.data) {
        setTenantLinkPool(mapSearchResults(res.data));
      }
    } catch {
      setTenantLinkPool([]);
    }
  }, [mapSearchResults, selectedTenantId]);

  const handleLinkSearch = useCallback((brokerId: number, query: string) => {
    void searchTenantAgentsForBroker(brokerId, query, 'link');
  }, [searchTenantAgentsForBroker]);

  const handleUplineSearch = useCallback((brokerId: number, query: string) => {
    void searchTenantAgentsForBroker(brokerId, query, 'upline');
  }, [searchTenantAgentsForBroker]);

  useEffect(() => {
    void preloadTenantLinkPool();
  }, [preloadTenantLinkPool]);

  useEffect(() => {
    if (!selectedTenantId) return;
    const linkSeeds: Record<number, LinkDropdownOption[]> = {};
    const queriesToSearch: Array<{ brokerId: number; query: string }> = [];

    for (const broker of workspace.brokers) {
      const override = getNodeOverride(draftJson, broker.e123BrokerId);
      if (broker.existingAgentId) {
        linkSeeds[broker.e123BrokerId] = [{
          id: broker.existingAgentId,
          value: broker.existingAgentId,
          label: broker.existingAgentName || broker.label || 'Linked agent',
          email: broker.email || undefined
        }];
      } else if (override.linkedUserId) {
        linkSeeds[broker.e123BrokerId] = [{
          id: `user:${override.linkedUserId}`,
          value: `user:${override.linkedUserId}`,
          label: broker.label || 'Linked user',
          email: broker.email || undefined,
          sublabel: 'Existing user — will add agent role'
        }];
      } else if (broker.existingUserId) {
        linkSeeds[broker.e123BrokerId] = [{
          id: `user:${broker.existingUserId}`,
          value: `user:${broker.existingUserId}`,
          label: broker.label || 'Linked user',
          email: broker.email || undefined,
          sublabel: 'Existing user — will add agent role'
        }];
      }

      if (broker.action === 'conflict') continue;
      if (broker.email) {
        queriesToSearch.push({ brokerId: broker.e123BrokerId, query: broker.email });
      }
      const nameQuery = [broker.firstName, broker.lastName].filter(Boolean).join(' ').trim() || broker.label;
      if (nameQuery) {
        queriesToSearch.push({ brokerId: broker.e123BrokerId, query: nameQuery });
      }
    }

    setLinkOptionsByBroker((prev) => {
      const next = { ...prev };
      for (const [brokerId, options] of Object.entries(linkSeeds)) {
        const id = Number(brokerId);
        next[id] = mergeLinkOptions(next[id], options);
      }
      return next;
    });

    const seenQueries = new Set<string>();
    for (const item of queriesToSearch) {
      const key = `${item.brokerId}:${item.query.toLowerCase()}`;
      if (seenQueries.has(key)) continue;
      seenQueries.add(key);
      void searchTenantAgentsForBroker(item.brokerId, item.query, 'link');
    }
  }, [workspace.brokers, selectedTenantId, draftJson, searchTenantAgentsForBroker]);

  const handleLinkAgent = useCallback(async (brokerId: number, linkValue: string, linkLabel: string) => {
    if (!instanceId || !selectedTenantId || !linkValue) return;
    const broker = workspace.brokers.find((b) => b.e123BrokerId === brokerId);
    const prevOverride = getNodeOverride(draftJson, brokerId);
    const isUserLink = linkValue.startsWith('user:');
    const nextOverride = { ...prevOverride };
    if (isUserLink) {
      nextOverride.linkedUserId = linkValue.slice(5);
      delete nextOverride.linkedAgentId;
    } else {
      nextOverride.linkedAgentId = linkValue;
      delete nextOverride.linkedUserId;
    }
    const nextDraft: AgentMigrationDraftJson = {
      ...draftJson,
      nodeOverrides: {
        ...draftJson.nodeOverrides,
        [brokerId]: nextOverride
      }
    };
    onDraftChange(nextDraft);
    setLinkSavingBrokerId(brokerId);
    try {
      if (!isUserLink) {
        const res = await e123MigrationService.saveAgentMap({
          instanceId,
          e123BrokerId: brokerId,
          agentId: linkValue,
          e123AgentLabel: broker?.label || null,
          tenantId: selectedTenantId
        });
        if (!res.success) throw new Error(res.message || 'Failed to save agent link');
      }
      setLinkOptionsByBroker((prev) => ({
        ...prev,
        [brokerId]: [{
          id: linkValue,
          value: linkValue,
          label: linkLabel,
          sublabel: isUserLink ? 'Existing user — will add agent role' : undefined
        }]
      }));
      await onWorkspaceRebuild?.(nextDraft);
    } catch (err) {
      setRosterError(err instanceof Error ? err.message : 'Failed to link agent');
    } finally {
      setLinkSavingBrokerId(null);
    }
  }, [draftJson, instanceId, onDraftChange, onWorkspaceRebuild, selectedTenantId, workspace.brokers]);

  const handleParentChange = useCallback(async (brokerId: number, parentRef: string) => {
    const nextDraft: AgentMigrationDraftJson = {
      ...draftJson,
      nodeOverrides: {
        ...draftJson.nodeOverrides,
        [brokerId]: {
          ...(draftJson.nodeOverrides?.[brokerId] || draftJson.nodeOverrides?.[String(brokerId)]),
          parentAb365Id: parentRef
        }
      }
    };
    onDraftChange(nextDraft);
    await onWorkspaceRebuild?.(nextDraft);
  }, [draftJson, onDraftChange, onWorkspaceRebuild]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <div className="text-sm font-medium text-gray-900">Hierarchy preview</div>
        <div className="text-xs text-gray-500 mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
          <span>{workspace.validation.createCount} to create</span>
          <span>{workspace.validation.mapOnlyCount} existing</span>
          {workspace.validation.noMembersExcludedCount ? (
            <span className="text-gray-600">
              {workspace.validation.noMembersExcludedCount} hidden (no active members)
            </span>
          ) : null}
          {workspace.validation.noEmailExcludedCount ? (
            <span className="text-gray-600">
              {workspace.validation.noEmailExcludedCount} hidden (no email)
            </span>
          ) : null}
          {conflictCount > 0 ? (
            <span className="text-red-700 font-medium">{conflictCount} conflict{conflictCount === 1 ? '' : 's'} block apply</span>
          ) : null}
          {rosterInfo?.matchedCount != null ? (
            <span>
              Roster {rosterInfo.matchedCount}/{rosterInfo.rowCount} matched
            </span>
          ) : null}
          {importableBrokers.length > 0 ? (
            <span>
              {includedCount}/{importableBrokers.length} included
            </span>
          ) : null}
        </div>
        {batchId ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {onRefreshPreview ? (
              <button
                type="button"
                onClick={() => void onRefreshPreview()}
                className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Refresh preview
              </button>
            ) : null}
            <input
              ref={rosterInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleRosterUpload(file);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={rosterUploading}
              onClick={() => rosterInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50"
            >
              {rosterUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              Upload commission roster
            </button>
            {rosterInfo?.fileName ? (
              <span className="text-xs text-gray-600 truncate max-w-md" title={rosterInfo.fileName}>
                {rosterInfo.fileName}
              </span>
            ) : (
              <span className="text-xs text-amber-800">
                Upload ShareWELL-Commission-Groups.xlsx (Roster tab) to pre-fill commission groups
              </span>
            )}
          </div>
        ) : null}
        {rosterError ? (
          <p className="text-xs text-red-700 mt-2">{rosterError}</p>
        ) : null}
        {conflictCount > 0 ? (
          <p className="text-xs text-red-800 mt-2 bg-red-50 border border-red-100 rounded-md px-2 py-1.5">
            Conflicts block apply — exclude those rows or fix the email conflict first.
          </p>
        ) : null}
        <p className="text-xs text-gray-600 mt-2">
          <strong>Commission group</strong> comes from the roster. <strong>Hierarchy level</strong> is from tree position or the agent&apos;s current level when linked.
          Agents auto-match on email when possible (same as member migration). Link each E123 broker with the dropdown.
          Root agent: pick agency or agent upline in one &quot;Reports to&quot; dropdown.
        </p>
        {tenantMismatch ? (
          <p className="text-xs text-red-800 mt-2 bg-red-50 border border-red-100 rounded-md px-2 py-1.5">
            Tier list is for a different tenant than selected — change target tenant and reload this step.
          </p>
        ) : null}
        {tiersError ? (
          <p className="text-xs text-red-800 mt-2 bg-red-50 border border-red-100 rounded-md px-2 py-1.5">
            {tiersError}
          </p>
        ) : null}
        <p className="text-xs text-gray-600 mt-2">
          {tiersLoading ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading commission levels…
            </span>
          ) : tiersFromTenantApi && tierOptions.length > 0 ? (
            <>
              <span className="text-green-700 font-medium">
                {tierOptions.length} tier{tierOptions.length === 1 ? '' : 's'} from database
              </span>
              {tenantName ? ` · ${tenantName}` : ''}
              {tiersLoadedForTenantId ? (
                <span className="text-gray-500 font-mono text-[10px] ml-1">
                  ({tiersLoadedForTenantId.slice(0, 8)}…)
                </span>
              ) : null}
              {tierOptionsMeta?.useCustomCommissionLevelsOnly ? ' · custom only' : ''}
            </>
          ) : tierOptions.length > 0 ? (
            <span>{tierOptions.map((t) => t.label).join(' · ')}</span>
          ) : (
            <span className="text-amber-800">No commission levels for this tenant.</span>
          )}
        </p>
      </div>

      <div className={`hidden xl:grid ${GRID_COLS} gap-x-3 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200 bg-gray-50/80`}>
        <span className="pl-6">Agent</span>
        <span>ID</span>
        <span>Match</span>
        <span>Commission group</span>
        <span>Hierarchy</span>
        <span>Bank</span>
        <span className="flex justify-center">
          <label className="inline-flex items-center gap-1 cursor-pointer" title="Include all agents in import">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allIncluded}
              disabled={importableBrokers.length === 0}
              onChange={(e) => handleSelectAllInclude(e.target.checked)}
              className="rounded border-gray-300"
            />
            <span className="normal-case tracking-normal font-medium text-[10px] text-gray-600 sr-only xl:not-sr-only">
              All
            </span>
          </label>
        </span>
      </div>

      <div className="max-h-[min(70vh,52rem)] overflow-x-auto overflow-y-auto px-1 sm:px-2 min-w-[52rem]">
        {treeRoot && rootBrokerId != null ? (
          <TreeNodeRow
            node={treeRoot}
            brokerById={brokerById}
            rootBrokerId={rootBrokerId}
            depth={0}
            draftJson={draftJson}
            tierOptions={tierOptions}
            groupOptions={groupOptions}
            tiersLoading={tiersLoading}
            tenantId={selectedTenantId}
            instanceId={instanceId}
            defaultAgencyId={defaultAgencyId}
            agencies={agencies}
            linkOptionsByBroker={linkOptionsByBroker}
            tenantLinkPool={tenantLinkPool}
            uplineOptionsByBroker={uplineOptionsByBroker}
            linkSearchLoadingBrokerId={linkSearchLoadingBrokerId}
            uplineSearchLoadingBrokerId={uplineSearchLoadingBrokerId}
            linkSavingBrokerId={linkSavingBrokerId}
            onLinkSearch={handleLinkSearch}
            onUplineSearch={handleUplineSearch}
            onLinkAgent={handleLinkAgent}
            onParentChange={handleParentChange}
            onTierChange={handleTierChange}
            onGroupChange={handleGroupChange}
            onToggleInclude={handleToggleInclude}
          />
        ) : (
          <ul className="divide-y divide-gray-100">
            {workspace.brokers.map((broker) => {
              const included = isBrokerIncluded(draftJson, broker.e123BrokerId, broker);
              const canToggle = brokerCanToggleInclude(broker);
              return (
              <li
                key={broker.e123BrokerId}
                className={`grid gap-3 px-3 py-3 text-sm ${GRID_COLS} ${canToggle && !included ? 'opacity-55' : ''}`}
              >
                <div>
                  <BrokerNameCell label={broker.label} email={broker.email} />
                  <span className="text-xs font-mono text-gray-400 ml-0">{broker.e123BrokerId}</span>
                </div>
                <span />
                <Ab365LinkCell
                  broker={broker}
                  brokerId={broker.e123BrokerId}
                  draftJson={draftJson}
                  isRoot={broker.e123BrokerId === rootBrokerId}
                  tenantId={selectedTenantId}
                  instanceId={instanceId}
                  agencies={agencies}
                  parentAb365Id={
                    draftJson.nodeOverrides?.[broker.e123BrokerId]?.parentAb365Id
                    || draftJson.nodeOverrides?.[String(broker.e123BrokerId)]?.parentAb365Id
                    || (defaultAgencyId ? `agency:${defaultAgencyId}` : '')
                  }
                  linkOptions={linkOptionsByBroker[broker.e123BrokerId] || []}
                  tenantLinkPool={tenantLinkPool}
                  uplineOptions={uplineOptionsByBroker[broker.e123BrokerId] || buildAgencyUplineOptions(agencies)}
                  linkSearchLoading={linkSearchLoadingBrokerId === broker.e123BrokerId}
                  uplineSearchLoading={uplineSearchLoadingBrokerId === broker.e123BrokerId}
                  linkSaving={linkSavingBrokerId === broker.e123BrokerId}
                  onLinkSearch={(query) => void handleLinkSearch(broker.e123BrokerId, query)}
                  onUplineSearch={(query) => void handleUplineSearch(broker.e123BrokerId, query)}
                  onLinkAgent={(linkValue, linkLabel) => void handleLinkAgent(broker.e123BrokerId, linkValue, linkLabel)}
                  onParentChange={(parentRef) => void handleParentChange(broker.e123BrokerId, parentRef)}
                />
                {included && canToggle ? (
                  <CommissionGroupSelect
                    broker={broker}
                    groupOptions={groupOptions}
                    groupSelectValue={
                      draftJson.nodeOverrides?.[broker.e123BrokerId]?.commissionGroupId
                      || draftJson.nodeOverrides?.[String(broker.e123BrokerId)]?.commissionGroupId
                      || broker.commissionGroupId
                      || broker.suggestedCommissionGroupId
                      || ''
                    }
                    onGroupChange={(groupId) => handleGroupChange(broker.e123BrokerId, groupId)}
                  />
                ) : (
                  <span className="text-xs text-gray-400">—</span>
                )}
                {included && canToggle ? (
                  <CommissionTierSelect
                    broker={broker}
                    tierOptions={tierOptions}
                    tiersLoading={tiersLoading}
                    tierSelectValue={broker.tierLevel}
                    onTierChange={(tier) => handleTierChange(broker.e123BrokerId, tier)}
                  />
                ) : (
                  <span className="text-xs text-gray-400">—</span>
                )}
                <BankHintCell broker={broker} />
                <div className="flex justify-center">
                  {canToggle ? (
                    <input
                      type="checkbox"
                      checked={included}
                      onChange={(e) => handleToggleInclude(broker.e123BrokerId, e.target.checked)}
                      className="rounded border-gray-300"
                      aria-label="Include in import"
                    />
                  ) : (
                    <span className="text-xs text-gray-400">—</span>
                  )}
                </div>
              </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
