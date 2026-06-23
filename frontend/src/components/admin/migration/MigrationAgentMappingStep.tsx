import { AlertTriangle, CheckCircle, Loader2, UserRound } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SearchableDropdown from '../../common/SearchableDropdown';
import {
  E123AgentMappingBroker,
  E123AgentMappingWorkspace,
  clearAgentMappingWorkspaceCache,
  e123MigrationService,
  readAgentMappingWorkspaceCache,
  writeAgentMappingWorkspaceCache
} from '../../../services/e123Migration.service';

interface Props {
  batchId: string;
  instanceId: string;
  tenantId: string;
  tenantName?: string;
  /** Households checked on Select Members (IncludedInImport). Scopes brokers shown. */
  selectedHouseholdCount?: number;
  /** Bumped when household selection changes so cached agent workspace is refreshed. */
  selectionRevision?: number;
}

function statusBadge(status: E123AgentMappingBroker['matchStatus']) {
  switch (status) {
    case 'mapped':
      return <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-50 text-green-800 border border-green-200">Mapped</span>;
    case 'manual':
      return <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 text-blue-800 border border-blue-200">Manual</span>;
    case 'suggested':
      return <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 text-amber-900 border border-amber-200">Suggested</span>;
    case 'needs_manual':
      return <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-orange-50 text-orange-900 border border-orange-200">Needs manual</span>;
    case 'cross_tenant':
      return <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-50 text-red-900 border border-red-200">Wrong tenant</span>;
    default:
      return <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-50 text-gray-600 border border-gray-200">Unmapped</span>;
  }
}

function matchDetailText(broker: E123AgentMappingBroker): string | null {
  if (!broker.matchMethod || broker.matchStatus === 'unmapped' || broker.matchStatus === 'needs_manual') {
    return null;
  }
  if (broker.matchMethod === 'email') {
    const e123 = broker.e123Email;
    const ab365 = broker.agentEmail;
    if (e123 && ab365) {
      return e123.toLowerCase() === ab365.toLowerCase()
        ? `Matched on email: ${e123}`
        : `Matched on email: ${e123} → ${ab365}`;
    }
    const email = e123 || ab365;
    return email ? `Matched on email: ${email}` : 'Matched on email';
  }
  if (broker.matchMethod === 'name') {
    const e123Name = [broker.e123FirstName, broker.e123LastName].filter(Boolean).join(' ')
      || broker.e123AgentLabel;
    const ab365Name = broker.agentName || 'unknown agent';
    return `Matched on exact name: ${e123Name} → ${ab365Name}`;
  }
  if (broker.matchMethod === 'manual') {
    return 'Manually mapped';
  }
  if (broker.matchMethod === 'saved') {
    return 'Previously saved mapping';
  }
  return null;
}

export default function MigrationAgentMappingStep({
  batchId,
  instanceId,
  tenantId,
  tenantName,
  selectedHouseholdCount,
  selectionRevision = 0
}: Props) {
  const [workspace, setWorkspace] = useState<E123AgentMappingWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingFromCache, setLoadingFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadWorkspace = useCallback(async (options?: { silent?: boolean; force?: boolean }) => {
    const cached = !options?.force
      ? readAgentMappingWorkspaceCache(batchId, tenantId, selectionRevision)
      : null;

    if (cached && !options?.silent && !options?.force) {
      setWorkspace(cached);
      setLoading(false);
      setLoadingFromCache(true);
    } else if (!options?.silent) {
      setLoading(true);
      setLoadingFromCache(false);
    }
    setError(null);
    try {
      const res = await e123MigrationService.getAgentMappingWorkspace(batchId, tenantId, {
        force: options?.force
      });
      if (!mountedRef.current) return;
      if (res.success && res.data) {
        setWorkspace(res.data);
        writeAgentMappingWorkspaceCache(batchId, tenantId, res.data, selectionRevision);
      } else if (!cached) {
        setError(res.message || 'Failed to load agent mappings');
      }
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      if (!cached) {
        setError(err instanceof Error ? err.message : 'Failed to load agent mappings');
      }
    } finally {
      if (mountedRef.current && !options?.silent) {
        setLoading(false);
        setLoadingFromCache(false);
      }
    }
  }, [batchId, tenantId, selectionRevision]);

  const [savingBrokerId, setSavingBrokerId] = useState<number | null>(null);
  const [searchLoadingBrokerId, setSearchLoadingBrokerId] = useState<number | null>(null);
  const [searchOptionsByBroker, setSearchOptionsByBroker] = useState<Record<number, Array<{
    id: string;
    label: string;
    value: string;
    email?: string;
    code?: string;
  }>>>({});

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  const searchTenantAgents = useCallback(async (brokerId: number, query: string) => {
    setSearchLoadingBrokerId(brokerId);
    try {
      const res = await e123MigrationService.searchTenantAgents(tenantId, query, 30);
      if (res.success && res.data) {
        setSearchOptionsByBroker((prev) => ({
          ...prev,
          [brokerId]: res.data
            .filter((agent) => agent.agentId)
            .map((agent) => ({
              id: agent.agentId!,
              value: agent.agentId!,
              label: agent.displayName,
              email: agent.email || undefined,
              code: agent.agentCode || undefined
            }))
        }));
      }
    } finally {
      setSearchLoadingBrokerId(null);
    }
  }, [tenantId]);

  const saveMapping = async (broker: E123AgentMappingBroker, agentId: string, agentName: string, agentEmail?: string | null) => {
    setSavingBrokerId(broker.e123BrokerId);
    setError(null);
    try {
      const res = await e123MigrationService.saveAgentMap({
        instanceId,
        e123BrokerId: broker.e123BrokerId,
        agentId,
        e123AgentLabel: broker.e123AgentLabel,
        tenantId
      });
      if (!res.success) {
        throw new Error(res.message || 'Failed to save agent mapping');
      }
      setSearchOptionsByBroker((prev) => ({
        ...prev,
        [broker.e123BrokerId]: [{
          id: agentId,
          value: agentId,
          label: agentName,
          email: agentEmail || undefined
        }]
      }));
      clearAgentMappingWorkspaceCache(batchId, tenantId, selectionRevision);
      await loadWorkspace({ silent: true, force: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save agent mapping');
    } finally {
      setSavingBrokerId(null);
    }
  };

  const summaryText = useMemo(() => {
    if (!workspace) return '';
    const parts = [
      `${workspace.totalBrokers} E123 agent(s) in selected households`,
      `${workspace.mappedCount} mapped`,
      workspace.suggestedCount ? `${workspace.suggestedCount} suggested` : null,
      workspace.needsManualCount ? `${workspace.needsManualCount} need manual pick` : null,
      workspace.crossTenantCount ? `${workspace.crossTenantCount} wrong tenant` : null,
      workspace.unmappedCount ? `${workspace.unmappedCount} unmapped` : null
    ].filter(Boolean);
    return parts.join(' · ');
  }, [workspace]);

  if (loading) {
    return (
      <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-5 space-y-3">
        <div className="flex items-center gap-2 text-sm text-sky-900 font-medium">
          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          {loadingFromCache ? 'Refreshing agent mappings…' : 'Loading agent mappings from E123…'}
        </div>
        <p className="text-sm text-sky-800/90">
          This step looks up each E123 selling broker in your batch. Large imports can take several minutes while E123
          responds — please stay on this page until loading finishes.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
        <div className="flex items-start gap-2">
          <UserRound className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Agent mapping for {tenantName || 'tenant'}</p>
            <p className="mt-1 text-sky-800/90">
              Pair each E123 selling broker from your{' '}
              {selectedHouseholdCount != null ? (
                <strong>{selectedHouseholdCount.toLocaleString()} selected household{selectedHouseholdCount === 1 ? '' : 's'}</strong>
              ) : (
                'selected households'
              )}{' '}
              to an AB365 agent in this tenant. Auto-match uses exact email or a unique exact name only —
              agency names like LLCs often need manual selection when multiple similar agents exist.
            </p>
            {summaryText ? <p className="mt-2 text-xs text-sky-700">{summaryText}</p> : null}
          </div>
        </div>
      </div>

      {workspace?.crossTenantCount ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">
              {workspace.crossTenantCount} saved agent mapping{workspace.crossTenantCount === 1 ? '' : 's'} point
              to an agent in another tenant
            </p>
            <p className="mt-1 text-red-800/90">
              {workspace.crossTenantMemberCount?.toLocaleString() ?? 0} household
              {(workspace.crossTenantMemberCount ?? 0) === 1 ? '' : 's'} will import without an agent until you
              re-map each broker to an agent in {tenantName || 'this tenant'}.
            </p>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1">{error}</div>
          <button type="button" onClick={() => loadWorkspace({ force: true })} className="text-red-800 underline text-sm shrink-0">
            Retry
          </button>
        </div>
      ) : null}

      {!workspace?.brokers.length ? (
        <div className="text-sm text-gray-500 py-4">No E123 agents found in selected households.</div>
      ) : (
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left py-2 px-3 text-gray-500 font-medium">E123 agent</th>
                <th className="text-left py-2 px-3 text-gray-500 font-medium">Members</th>
                <th className="text-left py-2 px-3 text-gray-500 font-medium">Status</th>
                <th className="text-left py-2 px-3 text-gray-500 font-medium min-w-[280px]">AB365 Agent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {workspace.brokers.map((broker) => {
                const selectedValue = broker.agentId || '';
                const dropdownOptions = searchOptionsByBroker[broker.e123BrokerId]?.length
                  ? searchOptionsByBroker[broker.e123BrokerId]
                  : broker.agentId && broker.agentName
                    ? [{
                      id: broker.agentId,
                      value: broker.agentId,
                      label: broker.agentName,
                      email: broker.agentEmail || undefined
                    }]
                    : [];
                const isSaving = savingBrokerId === broker.e123BrokerId;
                const matchDetail = matchDetailText(broker);

                return (
                  <tr key={broker.e123BrokerId} className="hover:bg-gray-50 align-top">
                    <td className="py-3 px-3">
                      <div className="font-medium text-gray-900">{broker.e123AgentLabel}</div>
                      <div className="text-xs text-gray-500">Broker {broker.e123BrokerId}</div>
                      {broker.e123Email ? (
                        <div className="text-xs text-gray-500 mt-1">{broker.e123Email}</div>
                      ) : null}
                      {!broker.e123Email && broker.e123FirstName && broker.e123LastName ? (
                        <div className="text-xs text-gray-500 mt-1">
                          {broker.e123FirstName} {broker.e123LastName}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-3 px-3">{broker.memberCount}</td>
                    <td className="py-3 px-3">{statusBadge(broker.matchStatus)}</td>
                    <td className="py-3 px-3">
                      <div className="space-y-2">
                        <SearchableDropdown
                          options={dropdownOptions}
                          value={selectedValue}
                          onChange={(value, label, option) => {
                            if (!value) return;
                            saveMapping(broker, value, label, option?.email);
                          }}
                          placeholder="Search tenant agents..."
                          searchPlaceholder="Search by name, email, or agent code..."
                          loading={isSaving || searchLoadingBrokerId === broker.e123BrokerId}
                          disabled={isSaving}
                          showEmail
                          showCode
                          useBackendSearch
                          onSearch={(query) => searchTenantAgents(broker.e123BrokerId, query)}
                          className="min-w-[260px]"
                        />
                        {matchDetail ? (
                          <p className="text-xs text-gray-500">{matchDetail}</p>
                        ) : null}
                        {broker.matchStatus === 'cross_tenant' ? (
                          <p className="text-xs text-red-700">
                            Saved mapping points to {broker.agentName || 'an agent'}
                            {broker.agentTenantName ? ` in ${broker.agentTenantName}` : ' in another tenant'}.
                            Pick an agent in {tenantName || 'this tenant'}.
                          </p>
                        ) : null}
                        {broker.matchStatus === 'needs_manual' && broker.e123Email ? (
                          <p className="text-xs text-gray-500">
                            E123 email {broker.e123Email} — no unique AB365 match found
                          </p>
                        ) : null}
                        {broker.matchStatus === 'suggested' && broker.agentId && broker.agentName ? (
                          <button
                            type="button"
                            disabled={isSaving}
                            onClick={() => saveMapping(broker, broker.agentId!, broker.agentName!, broker.agentEmail)}
                            className="inline-flex items-center gap-1 text-xs text-amber-800 hover:text-amber-900 disabled:opacity-50"
                          >
                            <CheckCircle className="h-3.5 w-3.5" />
                            Confirm suggested match
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
