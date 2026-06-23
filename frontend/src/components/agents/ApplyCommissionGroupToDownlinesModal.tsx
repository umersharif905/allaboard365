/**
 * ApplyCommissionGroupToDownlinesModal
 * Bulk apply a commission group to selected downline agents.
 * Shows a preview list with checkboxes; agents with existing group show "will replace X".
 * Optionally updates commission codes on their onboarding links.
 * Agents whose current group differs from the target are flagged at the top as conflicts.
 * Unchecking a conflicting agent also removes their own downline sub-tree.
 */

import { AlertCircle, AlertTriangle, Check, Loader2, Users, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'react-hot-toast';
import { TenantAdminAgentsService } from '../../services/tenant-admin/agents.service';

export interface DownlineAgent {
  agentId: string;
  agentName: string;
  email: string;
  commissionGroupId: string | null;
  commissionGroupName: string | null;
  level: number;
  parentAgentId: string | null;
}

interface ApplyCommissionGroupToDownlinesModalProps {
  isOpen: boolean;
  onClose: () => void;
  uplineAgentId: string;
  uplineAgentName: string;
  commissionGroups: { CommissionGroupId: string; Name: string; Status?: string }[];
  onSuccess?: () => void;
}

function buildDescendantMap(agents: DownlineAgent[], rootAgentId: string): Map<string, Set<string>> {
  const childrenMap = new Map<string, string[]>();
  for (const a of agents) {
    const parent = a.parentAgentId || rootAgentId;
    const key = parent.toLowerCase();
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key)!.push(a.agentId);
  }

  const descendantMap = new Map<string, Set<string>>();
  const getDescendants = (id: string): Set<string> => {
    const cached = descendantMap.get(id.toLowerCase());
    if (cached) return cached;
    const result = new Set<string>();
    const children = childrenMap.get(id.toLowerCase()) || [];
    for (const child of children) {
      result.add(child);
      for (const d of getDescendants(child)) result.add(d);
    }
    descendantMap.set(id.toLowerCase(), result);
    return result;
  };

  const allIds = new Set(agents.map((a) => a.agentId));
  allIds.add(rootAgentId);
  for (const id of allIds) getDescendants(id);
  return descendantMap;
}

const ApplyCommissionGroupToDownlinesModal: React.FC<ApplyCommissionGroupToDownlinesModalProps> = ({
  isOpen,
  onClose,
  uplineAgentId,
  uplineAgentName,
  commissionGroups,
  onSuccess
}) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downlineAgents, setDownlineAgents] = useState<DownlineAgent[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  const [updateCommissionCodes, setUpdateCommissionCodes] = useState(true);

  const loadDownline = useCallback(async () => {
    if (!uplineAgentId || !isOpen) return;
    setLoading(true);
    setError(null);
    try {
      const res = await TenantAdminAgentsService.getAgentDownlineAll(uplineAgentId);
      if (res.success && res.data) {
        setDownlineAgents(res.data);
        setSelectedIds(new Set(res.data.map((a) => a.agentId)));
      } else {
        setDownlineAgents([]);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load downline agents');
      setDownlineAgents([]);
    } finally {
      setLoading(false);
    }
  }, [uplineAgentId, isOpen]);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      setError(null);
      setSelectedGroupId('');
      setSearchTerm('');
      setUpdateCommissionCodes(true);
      loadDownline();
    }
  }, [isOpen, loadDownline]);

  const descendantMap = useMemo(
    () => buildDescendantMap(downlineAgents, uplineAgentId),
    [downlineAgents, uplineAgentId]
  );

  const activeGroups = commissionGroups.filter((g) => (g.Status || '').toLowerCase() === 'active');
  const selectedGroupName = activeGroups.find((g) => g.CommissionGroupId === selectedGroupId)?.Name || '';

  const { conflictAgents, nonConflictAgents } = useMemo(() => {
    if (!selectedGroupId) return { conflictAgents: [] as DownlineAgent[], nonConflictAgents: downlineAgents };
    const conflicts: DownlineAgent[] = [];
    const normal: DownlineAgent[] = [];
    for (const a of downlineAgents) {
      if (
        a.commissionGroupId &&
        a.commissionGroupId.toLowerCase() !== selectedGroupId.toLowerCase() &&
        a.commissionGroupName
      ) {
        conflicts.push(a);
      } else {
        normal.push(a);
      }
    }
    return { conflictAgents: conflicts, nonConflictAgents: normal };
  }, [downlineAgents, selectedGroupId]);

  const filteredConflicts = conflictAgents.filter((a) => {
    if (!searchTerm.trim()) return true;
    const term = searchTerm.toLowerCase();
    return (a.agentName || '').toLowerCase().includes(term) || (a.email || '').toLowerCase().includes(term);
  });

  const filteredNonConflicts = nonConflictAgents.filter((a) => {
    if (!searchTerm.trim()) return true;
    const term = searchTerm.toLowerCase();
    return (a.agentName || '').toLowerCase().includes(term) || (a.email || '').toLowerCase().includes(term);
  });

  const toggleAgent = (agentId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
        const descendants = descendantMap.get(agentId.toLowerCase());
        if (descendants) {
          for (const d of descendants) next.delete(d);
        }
      } else {
        next.add(agentId);
      }
      return next;
    });
  };

  const toggleAll = () => {
    const allFiltered = [...filteredConflicts, ...filteredNonConflicts];
    const allSelected = allFiltered.every((a) => selectedIds.has(a.agentId));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allFiltered.map((a) => a.agentId)));
    }
  };

  const handleApply = async () => {
    if (!selectedGroupId) {
      toast.error('Please select a commission group');
      return;
    }
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      toast.error('Please select at least one agent');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      let successCount = 0;
      let failCount = 0;
      for (const agentId of ids) {
        try {
          const res = await TenantAdminAgentsService.updateAgent(agentId, {
            commissionGroupId: selectedGroupId || null
          });
          if (res.success) successCount++;
          else failCount++;
        } catch {
          failCount++;
        }
      }

      let codeMsg = '';
      if (updateCommissionCodes && ids.length > 0) {
        try {
          const codeRes = await TenantAdminAgentsService.bulkUpdateCommissionCodes(ids, selectedGroupId);
          if (codeRes.success && codeRes.data) {
            codeMsg = ` Updated ${codeRes.data.updatedCodeCount} commission code(s).`;
          }
        } catch {
          codeMsg = ' (Failed to update some commission codes)';
        }
      }

      if (failCount > 0) {
        toast.error(`Updated ${successCount} agents. ${failCount} failed.${codeMsg}`);
      } else {
        toast.success(`Commission group applied to ${successCount} agent${successCount === 1 ? '' : 's'}.${codeMsg}`);
      }
      onSuccess?.();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to apply commission group');
      toast.error(err?.message || 'Failed to apply commission group');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const renderAgentRow = (agent: DownlineAgent, isConflict: boolean) => {
    const isSelected = selectedIds.has(agent.agentId);
    const hasExistingGroup = !!agent.commissionGroupName;
    const willReplace = hasExistingGroup && selectedGroupId && selectedGroupName !== agent.commissionGroupName;
    const isSkippedByParent = !isSelected && !isConflict;

    const descendants = descendantMap.get(agent.agentId.toLowerCase());
    const skippedDescCount = descendants
      ? [...descendants].filter((d) => !selectedIds.has(d)).length
      : 0;

    return (
      <div
        key={agent.agentId}
        className={`flex items-center gap-3 px-4 py-3 border-b border-gray-100 last:border-b-0 hover:bg-gray-50 ${
          isConflict && !isSelected ? 'bg-amber-50/60' : isSelected ? 'bg-blue-50/50' : ''
        }`}
      >
        <button
          type="button"
          onClick={() => toggleAgent(agent.agentId)}
          className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
            isSelected
              ? 'bg-oe-primary border-oe-primary text-white'
              : 'border-gray-300 hover:border-gray-400'
          }`}
        >
          {isSelected && <Check className="h-3 w-3" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {agent.level > 1 && (
              <span className="text-xs text-gray-400">{'└'.padStart(agent.level, ' ')}</span>
            )}
            <span className="font-medium text-gray-900 truncate">{agent.agentName}</span>
          </div>
          {agent.email && <div className="text-xs text-gray-500 truncate">{agent.email}</div>}
          {hasExistingGroup && (
            <div className="mt-1 text-xs">
              {willReplace ? (
                <span className="text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                  Will replace: {agent.commissionGroupName}
                </span>
              ) : (
                <span className="text-gray-500">Current: {agent.commissionGroupName}</span>
              )}
            </div>
          )}
          {!isSelected && skippedDescCount > 0 && (
            <div className="mt-1 text-xs text-gray-400 italic">
              +{skippedDescCount} downline agent{skippedDescCount === 1 ? '' : 's'} also skipped
            </div>
          )}
          {isSkippedByParent && (
            <div className="mt-0.5 text-xs text-gray-400 italic">Skipped (parent unchecked)</div>
          )}
        </div>
      </div>
    );
  };

  const totalFiltered = filteredConflicts.length + filteredNonConflicts.length;

  const modalContent = (
    <div className="fixed inset-0 z-[9999] overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="fixed inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
        <div className="relative w-full max-w-2xl bg-white rounded-lg shadow-xl">
          <div className="flex items-center justify-between p-6 border-b border-gray-200">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Apply Commission Group to Downlines</h2>
              <p className="text-sm text-gray-500 mt-1">
                Assign a commission group to selected agents in {uplineAgentName}&apos;s downline
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 p-1 rounded"
            >
              <X className="h-6 w-6" />
            </button>
          </div>

          <div className="p-6 space-y-4">
            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                <AlertCircle className="h-5 w-5 flex-shrink-0" />
                {error}
              </div>
            )}

            {loading ? (
              <div className="flex flex-col items-center justify-center py-16 gap-4">
                <Loader2 className="h-10 w-10 animate-spin text-oe-primary" />
                <span className="text-sm text-gray-600">Loading downline agents…</span>
              </div>
            ) : downlineAgents.length === 0 ? (
              <div className="text-center py-8 bg-gray-50 rounded-lg">
                <Users className="h-12 w-12 text-gray-400 mx-auto mb-2" />
                <p className="text-gray-600">No downline agents found</p>
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Commission Group to Apply
                  </label>
                  <select
                    value={selectedGroupId}
                    onChange={(e) => setSelectedGroupId(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  >
                    <option value="">Select a group</option>
                    {activeGroups.map((g) => (
                      <option key={g.CommissionGroupId} value={g.CommissionGroupId}>
                        {g.Name}
                      </option>
                    ))}
                  </select>
                </div>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={updateCommissionCodes}
                    onChange={(e) => setUpdateCommissionCodes(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                  />
                  <span className="text-sm text-gray-700">
                    Update all downline commission codes to use this commission group also
                  </span>
                </label>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium text-gray-700">
                      Agents ({totalFiltered})
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        placeholder="Search by name or email"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      />
                      <button
                        type="button"
                        onClick={toggleAll}
                        className="text-sm text-oe-primary hover:text-oe-dark font-medium"
                      >
                        {selectedIds.size === totalFiltered ? 'Deselect all' : 'Select all'}
                      </button>
                    </div>
                  </div>
                  <div className="border border-gray-200 rounded-lg max-h-64 overflow-y-auto">
                    {filteredConflicts.length > 0 && selectedGroupId && (
                      <>
                        <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs font-semibold text-amber-800">
                          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                          Already assigned to a different commission group — uncheck to skip (their downlines will also be skipped)
                        </div>
                        {filteredConflicts.map((agent) => renderAgentRow(agent, true))}
                        {filteredNonConflicts.length > 0 && (
                          <div className="px-4 py-1.5 bg-gray-100 text-xs text-gray-500 font-medium border-b border-gray-200">
                            Other agents
                          </div>
                        )}
                      </>
                    )}
                    {filteredNonConflicts.map((agent) => renderAgentRow(agent, false))}
                    {totalFiltered === 0 && (
                      <div className="text-center py-6 text-gray-500 text-sm">No agents match your search</div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {!loading && downlineAgents.length > 0 && (
            <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200 bg-gray-50">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleApply}
                disabled={saving || !selectedGroupId || selectedIds.size === 0}
                className="px-4 py-2 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-primary-dark disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Applying…
                  </>
                ) : (
                  `Apply to ${selectedIds.size} agent${selectedIds.size === 1 ? '' : 's'}`
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};

export default ApplyCommissionGroupToDownlinesModal;
