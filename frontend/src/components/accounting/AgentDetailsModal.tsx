// frontend/src/components/accounting/AgentDetailsModal.tsx
import { ChevronRight, Mail, Phone, User, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { AgentDetails, AgentHierarchy, TenantAdminAgentsService } from '../../services/tenant-admin/agents.service';

interface AgentDetailsModalProps {
  agentId: string;
  agentName?: string;
  isOpen: boolean;
  onClose: () => void;
}

interface UplineNode {
  agentId: string;
  name: string;
  email?: string;
  commissionRole?: string;
  level: number;
}

const AgentDetailsModal: React.FC<AgentDetailsModalProps> = ({
  agentId,
  agentName: initialAgentName,
  isOpen,
  onClose
}) => {
  const [agent, setAgent] = useState<AgentDetails | null>(null);
  const [upline, setUpline] = useState<AgentHierarchy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && agentId) {
      fetchAgentData();
    }
  }, [isOpen, agentId]);

  const fetchAgentData = async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch agent details
      const detailsResponse = await TenantAdminAgentsService.getAgentDetails(agentId);
      
      if (detailsResponse.success && detailsResponse.data) {
        setAgent(detailsResponse.data);
      } else {
        throw new Error(detailsResponse.message || 'Failed to load agent details');
      }

      // Fetch upline hierarchy
      const uplineResponse = await TenantAdminAgentsService.getAgentUpline(agentId);
      
      if (uplineResponse.success && uplineResponse.data) {
        setUpline(uplineResponse.data);
      }
    } catch (err: any) {
      console.error('Error fetching agent data:', err);
      setError(err.message || 'Failed to load agent information');
    } finally {
      setLoading(false);
    }
  };

  // Build upline chain - from root down to target agent (reverse order for display)
  const buildUplineChain = (): UplineNode[] => {
    const chain: UplineNode[] = [];
    
    // Add upline agents first (they should be at the top)
    upline.forEach((uplineAgent) => {
      if (uplineAgent.ParentAgent) {
        chain.push({
          agentId: uplineAgent.ParentAgent.AgentId || '',
          name: uplineAgent.ParentAgent.Name,
          email: uplineAgent.ParentAgent.Email,
          commissionRole: uplineAgent.ParentAgent.CommissionRole,
          level: uplineAgent.Level || chain.length + 1
        });
      }
    });

    // Sort by level (descending) so highest-level upline is first
    chain.sort((a, b) => b.level - a.level);
    
    // Add the target agent last (at the bottom)
    if (agent) {
      chain.push({
        agentId: agent.Id || agentId,
        name: agent.FirstName && agent.LastName 
          ? `${agent.FirstName} ${agent.LastName}` 
          : initialAgentName || 'Unknown Agent',
        email: agent.Email,
        commissionRole: agent.Role || undefined,
        level: 0
      });
    }

    return chain;
  };

  if (!isOpen) return null;

  const uplineChain = buildUplineChain();
  const displayName = agent 
    ? (agent.FirstName && agent.LastName ? `${agent.FirstName} ${agent.LastName}` : initialAgentName || 'Unknown Agent')
    : initialAgentName || 'Unknown Agent';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <User className="w-6 h-6 text-oe-primary" />
            <div>
              <h2 className="text-2xl font-semibold text-gray-900">Agent Details</h2>
              <p className="text-sm text-gray-600 mt-1">{displayName}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
              <span className="ml-3 text-gray-600">Loading agent details...</span>
            </div>
          ) : error ? (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-center gap-2">
                <X className="w-5 h-5 text-red-500" />
                <span className="text-red-700">{error}</span>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Agent Information */}
              <div className="bg-gray-50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Contact Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {agent?.Email && (
                    <div className="flex items-center gap-2 text-sm">
                      <Mail className="w-4 h-4 text-gray-500" />
                      <span className="text-gray-700">{agent.Email}</span>
                    </div>
                  )}
                  {agent?.Phone && (
                    <div className="flex items-center gap-2 text-sm">
                      <Phone className="w-4 h-4 text-gray-500" />
                      <span className="text-gray-700">{agent.Phone}</span>
                    </div>
                  )}
                  {agent?.NPN && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-gray-700">NPN:</span>
                      <span className="text-gray-700">{agent.NPN}</span>
                    </div>
                  )}
                  {agent?.Role && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-gray-700">Role:</span>
                      <span className="text-gray-700">{agent.Role}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Upline Hierarchy */}
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Upline Hierarchy</h3>
                {uplineChain.length === 0 ? (
                  <div className="text-center py-8 bg-gray-50 rounded-lg">
                    <User className="w-12 h-12 text-gray-400 mx-auto mb-2" />
                    <p className="text-gray-600">No upline hierarchy found</p>
                    <p className="text-sm text-gray-500 mt-1">This agent has no upline agents</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {uplineChain.map((node, index) => {
                      const isTarget = index === uplineChain.length - 1; // Last item is the target agent
                      const isLast = index === uplineChain.length - 1;
                      // Calculate reverse indentation: highest levels have less indent
                      const maxLevel = Math.max(...uplineChain.map(n => n.level).filter(l => l > 0), 0);
                      const reverseIndentLevel = Math.min(maxLevel - node.level, 5); // Cap indentation at 5 levels
                      return (
                        <div
                          key={node.agentId}
                          className={`flex items-start gap-3 p-4 rounded-lg border ${
                            isTarget
                              ? 'bg-blue-50 border-blue-200'
                              : 'bg-white border-gray-200 hover:bg-gray-50'
                          } transition-colors`}
                          style={{ marginLeft: `${reverseIndentLevel * 24}px` }}
                        >
                          {/* Hierarchy connector */}
                          {!isLast && (
                            <div className="flex-shrink-0 mt-2">
                              <ChevronRight className="w-4 h-4 text-gray-400" />
                            </div>
                          )}
                          {isLast && (
                            <div className="flex-shrink-0 mt-2">
                              <User className="w-5 h-5 text-oe-primary" />
                            </div>
                          )}

                          {/* Agent info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className={`font-semibold ${isTarget ? 'text-blue-900' : 'text-gray-900'}`}>
                                  {node.name}
                                </span>
                                {isTarget && (
                                  <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-blue-100 text-blue-800">
                                    Target Agent
                                  </span>
                                )}
                                {!isTarget && node.level > 0 && (
                                  <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-gray-200 text-gray-900">
                                    Level {node.level}
                                  </span>
                                )}
                                {node.commissionRole && (
                                  <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-gray-200 text-gray-900">
                                    {node.commissionRole}
                                  </span>
                                )}
                              </div>
                            </div>
                            {node.email && (
                              <div className="mt-1 flex items-center gap-1.5 text-sm text-gray-600">
                                <Mail className="w-3 h-3" />
                                <span>{node.email}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 p-4 bg-gray-50">
          <div className="flex items-center justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AgentDetailsModal;
