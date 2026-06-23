import { ChevronDown, ChevronRight, Loader2, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AgentOption,
  E123AgentTreeNode,
  e123MigrationService
} from '../../../services/e123Migration.service';

interface Props {
  instanceId: string;
  selectedAgentId: number | null;
  onSelect: (agent: AgentOption) => void;
  disabled?: boolean;
}

type LoadedChildren = Record<number, E123AgentTreeNode[]>;

function nodeToAgentOption(node: E123AgentTreeNode): AgentOption {
  return {
    rootBrokerId: node.agentId,
    rootAgentLabel: node.label,
    label: node.label,
    parentLabel: node.parentLabel || undefined,
    parentBrokerId: node.parentAgentId,
    includeDownline: true
  };
}

function AgentTreeRow({
  node,
  depth,
  expanded,
  loading,
  selected,
  onToggle,
  onSelect,
  disabled
}: {
  node: E123AgentTreeNode;
  depth: number;
  expanded: boolean;
  loading: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  disabled?: boolean;
}) {
  const hasChildren = node.hasChildren || node.childCount > 0;

  return (
    <div
      className={`flex items-center gap-1 rounded-md px-2 py-1.5 text-sm ${
        selected ? 'bg-blue-100 text-blue-900' : 'hover:bg-gray-50'
      }`}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      {hasChildren ? (
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled}
          className="shrink-0 p-0.5 text-gray-500 hover:text-gray-700 disabled:opacity-50"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>
      ) : (
        <span className="w-5 shrink-0" />
      )}
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        className="min-w-0 flex-1 text-left disabled:opacity-50"
      >
        <span className="font-medium text-gray-900">{node.label}</span>
        {node.isGroup === true ? (
          <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded ml-2">
            Agency
          </span>
        ) : node.isGroup === false ? (
          <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded ml-2">
            Agent
          </span>
        ) : null}
        <span className="text-xs text-gray-500 ml-2">Broker {node.agentId}</span>
        {node.childCount > 0 ? (
          <span className="text-xs text-gray-400 ml-2">
            {node.childCount} direct · {node.totalDownlineCount ?? 0} in downline (all levels)
          </span>
        ) : null}
      </button>
    </div>
  );
}

export default function AgentTreePicker({
  instanceId,
  selectedAgentId,
  onSelect,
  disabled = false
}: Props) {
  const [rootBrokerId, setRootBrokerId] = useState<number | null>(null);
  const [rootLabel, setRootLabel] = useState<string | null>(null);
  const [topLevelNodes, setTopLevelNodes] = useState<E123AgentTreeNode[]>([]);
  const [childrenByParent, setChildrenByParent] = useState<LoadedChildren>({});
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());
  const [loadingParentIds, setLoadingParentIds] = useState<Set<number>>(() => new Set());
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<AgentOption[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const loadChildren = useCallback(async (parentAgentId: number | null) => {
    const res = await e123MigrationService.getAgentTreeChildren(parentAgentId, instanceId);
    if (!res.success || !res.data) {
      throw new Error('Failed to load agent tree');
    }
    return res.data;
  }, [instanceId]);

  useEffect(() => {
    let cancelled = false;
    setInitialLoading(true);
    setLoadError(null);
    void loadChildren(null)
      .then((data) => {
        if (cancelled) return;
        setRootBrokerId(data.rootBrokerId);
        setRootLabel(data.rootLabel);
        setTopLevelNodes(data.nodes || []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load agent tree');
        }
      })
      .finally(() => {
        if (!cancelled) setInitialLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [instanceId, loadChildren]);

  const ensureChildrenLoaded = useCallback(async (parentAgentId: number) => {
    if (childrenByParent[parentAgentId]) return;
    setLoadingParentIds((prev) => new Set(prev).add(parentAgentId));
    try {
      const data = await loadChildren(parentAgentId);
      setChildrenByParent((prev) => ({ ...prev, [parentAgentId]: data.nodes || [] }));
    } finally {
      setLoadingParentIds((prev) => {
        const next = new Set(prev);
        next.delete(parentAgentId);
        return next;
      });
    }
  }, [childrenByParent, loadChildren]);

  const toggleExpanded = useCallback(async (node: E123AgentTreeNode) => {
    const next = new Set(expandedIds);
    if (next.has(node.agentId)) {
      next.delete(node.agentId);
      setExpandedIds(next);
      return;
    }
    next.add(node.agentId);
    setExpandedIds(next);
    await ensureChildrenLoaded(node.agentId);
  }, [expandedIds, ensureChildrenLoaded]);

  const handleSearch = useCallback(async (query: string) => {
    setSearchQuery(query);
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults([]);
      return;
    }
    setSearchLoading(true);
    try {
      const res = await e123MigrationService.searchAgents(trimmed, 100, false, instanceId);
      if (res.success && res.data) {
        setSearchResults(res.data.agents || []);
      }
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, [instanceId]);

  const visibleRows = useMemo(() => {
    const rows: Array<{ node: E123AgentTreeNode; depth: number }> = [];

    const walk = (nodes: E123AgentTreeNode[], depth: number) => {
      for (const node of nodes) {
        rows.push({ node, depth });
        if (expandedIds.has(node.agentId)) {
          walk(childrenByParent[node.agentId] || [], depth + 1);
        }
      }
    };

    walk(topLevelNodes, 0);
    return rows;
  }, [topLevelNodes, expandedIds, childrenByParent]);

  if (initialLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-6">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading agent tree…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-md border border-red-100 bg-red-50 px-3 py-3 text-sm text-red-800">
        {loadError}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rootBrokerId ? (
        <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          Organization root: <span className="font-medium text-gray-900">{rootLabel || `Broker ${rootBrokerId}`}</span>
          {' '}({rootBrokerId}) — top-level agencies and agents below. Expand to drill into downline, then click to select import root.
        </div>
      ) : null}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => void handleSearch(e.target.value)}
          placeholder="Search entire tree by name or broker ID…"
          disabled={disabled}
          className="w-full rounded-md border border-gray-300 pl-9 pr-3 py-2 text-sm"
        />
      </div>

      {searchQuery.trim() ? (
        <div className="rounded-md border border-gray-200 max-h-80 overflow-y-auto">
          {searchLoading ? (
            <div className="flex items-center gap-2 px-3 py-4 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Searching…
            </div>
          ) : searchResults.length === 0 ? (
            <div className="px-3 py-4 text-sm text-gray-500">No agents match your search.</div>
          ) : (
            searchResults.map((agent) => (
              <button
                key={agent.rootBrokerId}
                type="button"
                disabled={disabled}
                onClick={() => onSelect(agent)}
                className={`block w-full text-left px-3 py-2 text-sm border-b border-gray-100 last:border-b-0 hover:bg-gray-50 disabled:opacity-50 ${
                  selectedAgentId === agent.rootBrokerId ? 'bg-blue-50' : ''
                }`}
              >
                <div className="font-medium text-gray-900">{agent.label || agent.rootAgentLabel}</div>
                <div className="text-xs text-gray-500">
                  Broker {agent.rootBrokerId}
                  {agent.parentLabel ? ` · Upline: ${agent.parentLabel}` : ''}
                  {(agent.childCount ?? 0) > 0
                    ? ` · ${agent.childCount} direct · ${agent.totalDownlineCount ?? 0} in downline (all levels)`
                    : ''}
                </div>
              </button>
            ))
          )}
        </div>
      ) : (
        <div className="rounded-md border border-gray-200 max-h-80 overflow-y-auto py-1">
          {visibleRows.length === 0 ? (
            <div className="px-3 py-4 text-sm text-gray-500">No agents found in uploaded tree.</div>
          ) : (
            visibleRows.map(({ node, depth }) => (
              <AgentTreeRow
                key={node.agentId}
                node={node}
                depth={depth}
                expanded={expandedIds.has(node.agentId)}
                loading={loadingParentIds.has(node.agentId)}
                selected={selectedAgentId === node.agentId}
                disabled={disabled}
                onToggle={() => void toggleExpanded(node)}
                onSelect={() => onSelect(nodeToAgentOption(node))}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
