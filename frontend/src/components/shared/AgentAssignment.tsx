// File: frontend/src/components/shared/AgentAssignment.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';
import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';
import SearchableDropdown from '../common/SearchableDropdown';

export type AssignableAgentsPayload = {
  mode: 'agency' | 'downline' | 'none';
  agents: Array<{
    agentId: string;
    userId: string;
    firstName: string;
    lastName: string;
    email: string;
    /** From oe.Agencies when joined (assignable-agents API). */
    agencyName?: string;
  }>;
};

interface AgentAssignmentProps {
  value: string;
  onChange: (agentId: string) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  currentAgentName?: string;
  currentAgentEmail?: string;
  /** Agent: GET /api/me/agent/assignable-agents for create-household (no forMemberId) */
  assignableNewMember?: boolean;
  /** Agent: preloaded list (e.g. MemberEdit after GET ?forMemberId=) */
  assignableAgentsPayload?: AssignableAgentsPayload | null;
}

function optionsFromAssignablePayload(payload: AssignableAgentsPayload) {
  return payload.agents.map((a) => {
    const agency = (a.agencyName || '').trim();
    return {
      id: a.agentId,
      label: `${a.firstName} ${a.lastName}`.trim() || 'Agent',
      value: a.agentId,
      email: a.email || '',
      sublabel: agency || undefined
    };
  });
}

const AgentAssignment: React.FC<AgentAssignmentProps> = ({
  value,
  onChange,
  label = 'Assign to Agent',
  required = false,
  disabled = false,
  currentAgentName,
  currentAgentEmail,
  assignableNewMember = false,
  assignableAgentsPayload
}) => {
  const { user } = useAuth();
  /**
   * Active portal role only (matches prompts/backend-system.md — hooks/endpoints follow currentRole,
   * not the roles[] membership list).
   */
  const role = user?.currentRole;
  const isAgentPortal = role === 'Agent' || role === 'AgencyOwner';
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [agentOptions, setAgentOptions] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const hasAttemptedFetch = useRef(false);
  const [showAgentDropdown, setShowAgentDropdown] = useState(false);
  const [newMemberAssignable, setNewMemberAssignable] = useState<AssignableAgentsPayload | null>(null);
  const [loadingNewMemberAssignable, setLoadingNewMemberAssignable] = useState(false);
  /** Only the latest tenant-admin agent search may update options (avoids stale results while typing). */
  const tenantAgentSearchSeqRef = useRef(0);

  const setAgentToSelf = useCallback(async () => {
    console.log('🚀 setAgentToSelf called');
    try {
      setLoadingAgents(true);
      setError(null);
      const response = (await apiService.get('/api/me/agent/profile')) as any;

      if (!response.success || !response.data) {
        throw new Error('Failed to fetch agent profile from API');
      }

      const agent = response.data;
      if (!agent.AgentId) {
        throw new Error('AgentId not found in API response');
      }

      const agentOption = {
        id: agent.AgentId,
        label: `${agent.FirstName} ${agent.LastName}`,
        value: agent.AgentId,
        email: agent.Email,
        tenantName: ''
      };
      setAgentOptions([agentOption]);
      onChange(agent.AgentId);
    } catch (err) {
      console.error('❌ Error fetching agent profile:', err);
      setError(err instanceof Error ? err.message : 'Failed to load agent information');
      setAgentOptions([]);
    } finally {
      setLoadingAgents(false);
    }
  }, [onChange]);

  const fetchAgents = useCallback(
    async (searchQuery: string = '') => {
      const requestId = ++tenantAgentSearchSeqRef.current;
      try {
        setLoadingAgents(true);
        const response = await TenantAdminService.getTenantAgents({
          status: 'Active',
          search: searchQuery,
          limit: 50
        });

        if (requestId !== tenantAgentSearchSeqRef.current) {
          return;
        }

        if (response.success && response.data) {
          const uniqueAgents = Array.from(
            new Map(response.data.map((agent: any) => [agent.Id, agent])).values()
          );

          const options = uniqueAgents.map((agent: any, index: number) => {
            let lbl = agent.Name;
            if (user?.currentRole === 'SysAdmin' && agent.TenantName) {
              lbl += `\n(${agent.TenantName})`;
            }

            const agency = (agent.AgencyName || '').trim();

            return {
              id: agent.Id || `agent-${index}`,
              label: lbl,
              value: agent.Id,
              email: agent.Email,
              tenantName: agent.TenantName,
              sublabel: agency || undefined
            };
          });

          if (value && currentAgentName && !options.find((opt) => opt.value === value)) {
            options.unshift({
              id: value,
              label: currentAgentName,
              value: value,
              email: currentAgentEmail || '',
              tenantName: '',
              sublabel: undefined
            });
          }

          setAgentOptions(options);
        }
      } catch (err) {
        console.error('Error fetching agents:', err);
      } finally {
        if (requestId === tenantAgentSearchSeqRef.current) {
          setLoadingAgents(false);
        }
      }
    },
    [user?.currentRole, value, currentAgentName, currentAgentEmail]
  );

  const handleAgentSearch = useCallback(
    (query: string) => {
      fetchAgents(query);
    },
    [fetchAgents]
  );

  useEffect(() => {
    hasAttemptedFetch.current = false;
    setError(null);
  }, [user?.currentRole]);

  useEffect(() => {
    setShowAgentDropdown(false);
  }, [value, currentAgentName]);

  // Agent + MemberEdit: options from parent (GET assignable-agents?forMemberId=)
  useEffect(() => {
    if (!isAgentPortal || !assignableAgentsPayload || assignableAgentsPayload.mode === 'none') {
      return;
    }
    setAgentOptions(optionsFromAssignablePayload(assignableAgentsPayload));
  }, [isAgentPortal, assignableAgentsPayload]);

  // Agent + new household: fetch assignable list (same endpoint as UI permission source)
  useEffect(() => {
    if (!isAgentPortal || !assignableNewMember || assignableAgentsPayload != null) {
      return;
    }
    let cancelled = false;
    setLoadingNewMemberAssignable(true);
    setNewMemberAssignable(null);
    (async () => {
      try {
        const res = (await apiService.get('/api/me/agent/assignable-agents')) as {
          success?: boolean;
          data?: AssignableAgentsPayload;
        };
        if (!cancelled && res?.success && res.data) {
          setNewMemberAssignable(res.data);
        } else if (!cancelled) {
          setNewMemberAssignable({ mode: 'none', agents: [] });
        }
      } catch {
        if (!cancelled) setNewMemberAssignable({ mode: 'none', agents: [] });
      } finally {
        if (!cancelled) setLoadingNewMemberAssignable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAgentPortal, assignableNewMember, assignableAgentsPayload]);

  // Agent + new member: mode none → self only; else options from API
  useEffect(() => {
    if (!isAgentPortal || !assignableNewMember || assignableAgentsPayload != null) {
      return;
    }
    if (loadingNewMemberAssignable || !newMemberAssignable) {
      return;
    }
    if (newMemberAssignable.mode === 'none') {
      setAgentToSelf();
      return;
    }
    setAgentOptions(optionsFromAssignablePayload(newMemberAssignable));
  }, [
    isAgentPortal,
    assignableNewMember,
    assignableAgentsPayload,
    newMemberAssignable,
    loadingNewMemberAssignable,
    setAgentToSelf
  ]);

  // Agent default (no assignable props): self only — TenantAdmin/SysAdmin use tenant agent list below.
  useEffect(() => {
    if (!isAgentPortal || assignableAgentsPayload != null || assignableNewMember) {
      return;
    }
    if (loadingAgents || hasAttemptedFetch.current || agentOptions.length > 0) {
      return;
    }
    hasAttemptedFetch.current = true;
    setAgentToSelf();
  }, [isAgentPortal, assignableAgentsPayload, assignableNewMember, loadingAgents, agentOptions.length, setAgentToSelf, role]);

  // TenantAdmin / SysAdmin: load tenant agents when no current agent
  useEffect(() => {
    console.log('🔍 AgentAssignment mounted with value:', {
      value,
      currentAgentName,
      currentAgentEmail,
      userRole: user?.currentRole,
      loadingAgents,
      agentOptionsLength: agentOptions.length,
      hasAttemptedFetch: hasAttemptedFetch.current
    });

    if (role === 'Agent' || role === 'AgencyOwner') {
      return;
    }
    if (loadingAgents || hasAttemptedFetch.current) {
      return;
    }

    if ((role === 'TenantAdmin' || role === 'SysAdmin') && !(value && currentAgentName)) {
      hasAttemptedFetch.current = true;
      fetchAgents();
    }
  }, [role, value, currentAgentName, currentAgentEmail, loadingAgents, fetchAgents]);

  const canShowAgentAssignment =
    role === 'SysAdmin' ||
    role === 'TenantAdmin' ||
    role === 'Agent' ||
    role === 'AgencyOwner';

  /** Prefer dropdown option for value so the blue card reflects a newly selected agent before save */
  const displayAgentName = useMemo(() => {
    const opt = agentOptions.find((o) => o.value === value);
    if (opt?.label) return opt.label;
    return currentAgentName || '';
  }, [agentOptions, value, currentAgentName]);

  const displayAgentEmail = useMemo(() => {
    const opt = agentOptions.find((o) => o.value === value);
    if (opt?.email != null && String(opt.email).trim() !== '') return opt.email;
    return currentAgentEmail || '';
  }, [agentOptions, value, currentAgentEmail]);

  if (!user?.currentRole) {
    return (
      <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
        Sign in to view or assign agent information.
      </div>
    );
  }
  if (!canShowAgentAssignment) {
    return (
      <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
        Agent assignment is not available for your role in this portal.
      </div>
    );
  }

  const hasCurrentAgent = !!(value && (currentAgentName || displayAgentName));
  const shouldShowDropdown = !hasCurrentAgent || showAgentDropdown;

  const agentAssignableFromParent =
    isAgentPortal &&
    assignableAgentsPayload &&
    assignableAgentsPayload.mode !== 'none';

  const agentAssignableFromNewMemberFetch =
    isAgentPortal &&
    assignableNewMember &&
    assignableAgentsPayload == null &&
    newMemberAssignable &&
    newMemberAssignable.mode !== 'none' &&
    !loadingNewMemberAssignable;

  const showAgentAssignableUi = agentAssignableFromParent || agentAssignableFromNewMemberFetch;

  if (isAgentPortal && assignableNewMember && assignableAgentsPayload == null && loadingNewMemberAssignable) {
    return (
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {label} {required && <span className="text-red-600">*</span>}
        </label>
        <div className="w-full p-2 border border-gray-300 rounded-md bg-gray-50 text-gray-600 flex items-center">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-400 mr-2" />
          <span>Loading agents…</span>
        </div>
      </div>
    );
  }

  if (showAgentAssignableUi) {
    return (
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {label} {required && <span className="text-red-600">*</span>}
        </label>
        {shouldShowDropdown ? (
          <div>
            <SearchableDropdown
              options={agentOptions}
              value={value}
              onChange={(selectedValue) => {
                onChange(selectedValue);
                if (hasCurrentAgent) {
                  setShowAgentDropdown(false);
                }
              }}
              placeholder="Select an agent..."
              searchPlaceholder="Search by name or email..."
              loading={loadingAgents}
              disabled={disabled}
              showEmail={true}
              showSublabel={true}
              multiLine={true}
              className="w-full"
              useBackendSearch={false}
            />
            {hasCurrentAgent && (
              <button
                type="button"
                onClick={() => setShowAgentDropdown(false)}
                className="mt-2 text-xs text-gray-600 hover:text-gray-800 underline"
              >
                Cancel change
              </button>
            )}
          </div>
        ) : (
          <div>
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h4 className="font-medium text-blue-900 mb-1">Current Agent</h4>
                  <div className="space-y-1 text-sm text-blue-800">
                    <p>
                      <strong>Name:</strong> {displayAgentName}
                    </p>
                    {displayAgentEmail && (
                      <p>
                        <strong>Email:</strong> {displayAgentEmail}
                      </p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAgentDropdown(true)}
                  className="ml-4 px-3 py-1.5 text-sm font-medium text-oe-primary-dark bg-blue-100 hover:bg-blue-200 rounded-lg transition-colors"
                >
                  Change Agent
                </button>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-1">Click &quot;Change Agent&quot; to assign a different agent</p>
          </div>
        )}
      </div>
    );
  }

  if (isAgentPortal) {
    return (
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {label} {required && <span className="text-red-600">*</span>}
        </label>
        <div>
          <div className="w-full p-2 border border-gray-300 rounded-md bg-gray-50 text-gray-600 flex items-center">
            {loadingAgents ? (
              <div className="flex items-center">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-400 mr-2"></div>
                <span>Loading agent info...</span>
              </div>
            ) : error ? (
              <div className="flex items-center text-red-600">
                <span>❌ {error}</span>
              </div>
            ) : (
              <span>{agentOptions.length > 0 ? agentOptions[0].label : 'Agent'}</span>
            )}
          </div>
          {!error && (
            <p className="text-xs text-gray-500 mt-1">
              You will be automatically assigned as the agent for this member
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label} {required && <span className="text-red-600">*</span>}
      </label>
      {shouldShowDropdown ? (
        <div>
          <SearchableDropdown
            options={agentOptions}
            value={value}
            onChange={(selectedValue) => {
              onChange(selectedValue);
              if (hasCurrentAgent) {
                setShowAgentDropdown(false);
              }
            }}
            placeholder="Select an agent..."
            searchPlaceholder="Search agents by name or email..."
            loading={loadingAgents}
            disabled={disabled}
            showEmail={true}
            showSublabel={true}
            multiLine={true}
            className="w-full"
            onSearch={handleAgentSearch}
            useBackendSearch={true}
          />
          {hasCurrentAgent && (
            <button
              type="button"
              onClick={() => setShowAgentDropdown(false)}
              className="mt-2 text-xs text-gray-600 hover:text-gray-800 underline"
            >
              Cancel change
            </button>
          )}
        </div>
      ) : (
        <div>
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <h4 className="font-medium text-blue-900 mb-1">Current Agent</h4>
                <div className="space-y-1 text-sm text-blue-800">
                  <p>
                    <strong>Name:</strong> {displayAgentName}
                  </p>
                  {displayAgentEmail && (
                    <p>
                      <strong>Email:</strong> {displayAgentEmail}
                    </p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowAgentDropdown(true);
                  if (agentOptions.length === 0 && !hasAttemptedFetch.current) {
                    fetchAgents();
                  }
                }}
                className="ml-4 px-3 py-1.5 text-sm font-medium text-oe-primary-dark bg-blue-100 hover:bg-blue-200 rounded-lg transition-colors"
              >
                Change Agent
              </button>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-1">Click &quot;Change Agent&quot; to assign a different agent</p>
        </div>
      )}
    </div>
  );
};

export default AgentAssignment;
