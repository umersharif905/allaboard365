import { Building, ChevronDown, ChevronRight, Mail, Phone, User, Users, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';

interface HierarchyNode {
  id: string;
  type: 'tenant' | 'agency' | 'agent';
  name: string;
  email?: string;
  phone?: string;
  status?: string;
  commissionRole?: string;
  npn?: string;
  children?: HierarchyNode[];
  agents?: HierarchyNode[];
  agencies?: HierarchyNode[];
}

interface HierarchyData {
  tenant: HierarchyNode;
  agencies: HierarchyNode[];
}

interface ApiResponse {
  success: boolean;
  data?: HierarchyData;
  message?: string;
}

interface HierarchyTreeModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentRole?: string;
}

const HierarchyTreeNode: React.FC<{
  node: HierarchyNode;
  level: number;
}> = ({ node, level }) => {
  const [isExpanded, setIsExpanded] = useState(level < 2);
  
  const hasChildren = 
    (node.children && node.children.length > 0) ||
    (node.agents && node.agents.length > 0) ||
    (node.agencies && node.agencies.length > 0);
  
  const getIcon = () => {
    switch (node.type) {
      case 'tenant':
        return <Building className="w-5 h-5 text-oe-primary" />;
      case 'agency':
        return <Building className="w-4 h-4 text-gray-700" />;
      case 'agent':
        return <User className="w-4 h-4 text-green-600" />;
      default:
        return <User className="w-4 h-4 text-gray-600" />;
    }
  };
  
  const getBackgroundColor = () => {
    switch (node.type) {
      case 'tenant':
        return 'bg-blue-50 border-blue-200';
      case 'agency':
        return 'bg-gray-100 border-gray-300';
      case 'agent':
        return 'bg-green-50 border-green-200';
      default:
        return 'bg-gray-50 border-gray-200';
    }
  };
  
  const childNodes = node.children || node.agents || node.agencies || [];
  
  return (
    <div className="ml-0">
      <div
        className={`flex items-start gap-3 p-3 rounded-lg border ${getBackgroundColor()} hover:shadow-sm transition-shadow cursor-pointer mb-2`}
        onClick={() => hasChildren && setIsExpanded(!isExpanded)}
      >
        {hasChildren && (
          <button
            className="mt-1 flex-shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
          >
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 text-gray-600" />
            ) : (
              <ChevronRight className="w-4 h-4 text-gray-600" />
            )}
          </button>
        )}
        
        {!hasChildren && <div className="w-4" />}
        
        <div className="flex-shrink-0 mt-0.5">{getIcon()}</div>
        
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-gray-900">{node.name}</span>
            {node.type === 'tenant' && (
              <span 
                className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-blue-100 text-blue-800 cursor-help"
                title="Organization - Top-level tenant entity"
              >
                Organization
              </span>
            )}
            {node.type === 'agency' && (
              <span 
                className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-gray-200 text-gray-900 cursor-help"
                title="Agency - Insurance agency entity"
              >
                Agency
              </span>
            )}
            {node.type === 'agent' && (
              <span 
                className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-green-100 text-green-800 cursor-help"
                title="Agent - Individual insurance agent"
              >
                Agent
              </span>
            )}
            </div>
            
            {hasChildren && (
              <div className="text-xs text-gray-500 ml-4">
                {childNodes.length} {childNodes.length === 1 ? 'member' : 'members'}
              </div>
            )}
          </div>
          
          <div className="mt-1 space-y-1">
            {node.email && (
              <div className="flex items-center gap-1.5 text-sm text-gray-600">
                <Mail className="w-3 h-3" />
                <span>{node.email}</span>
              </div>
            )}
            {node.phone && (
              <div className="flex items-center gap-1.5 text-sm text-gray-600">
                <Phone className="w-3 h-3" />
                <span>{node.phone}</span>
              </div>
            )}
          </div>
        </div>
      </div>
      
      {isExpanded && childNodes.length > 0 && (
        <div className="ml-6 mt-2 pl-4 border-l-2 border-gray-200">
          {childNodes.map((child) => (
            <HierarchyTreeNode
              key={child.id}
              node={child}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const HierarchyTreeModal: React.FC<HierarchyTreeModalProps> = ({
  isOpen,
  onClose,
  currentRole = 'TenantAdmin'
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hierarchyData, setHierarchyData] = useState<HierarchyData | null>(null);

  useEffect(() => {
    if (isOpen) {
      fetchHierarchy();
    }
  }, [isOpen, currentRole]);

  const fetchHierarchy = async () => {
    setLoading(true);
    setError(null);
    
    try {
      console.log('📊 Fetching organization hierarchy...');
      
      // Use role-aware endpoint
      const endpoint = currentRole === 'Agent' 
        ? '/api/me/agent/agents/hierarchy'
        : '/api/tenant-admin/agents/hierarchy';
      
      const response = await apiService.get(endpoint) as any;
      
      if (response.success) {
        console.log('✅ Hierarchy data fetched:', response.data);
        
        // Transform Agent response to match expected format
        if (currentRole === 'Agent' && response.data?.hierarchy !== undefined) {
          // Check if hierarchy is empty
          if (!response.data.hierarchy || response.data.hierarchy.length === 0) {
            // No downline agents - set empty state
            setHierarchyData({
              tenant: {
                id: 'agent-view',
                type: 'tenant' as const,
                name: response.data.agency?.AgencyName || 'Your Agency',
                agencies: []
              },
              agencies: []
            });
            return;
          }
          
          // Build hierarchy tree from flat list
          const hierarchyMap = new Map();
          
          // Map all agents by ID
          response.data.hierarchy.forEach((agent: any) => {
            hierarchyMap.set(agent.AgentId, {
              id: agent.AgentId,
              type: 'agent' as const,
              name: `${agent.FirstName} ${agent.LastName}`,
              email: agent.Email,
              commissionRole: agent.CommissionRole,
              npn: agent.NPN,
              children: []
            });
          });
          
          // Build tree structure
          const rootAgents: HierarchyNode[] = [];
          response.data.hierarchy.forEach((agent: any) => {
            const node = hierarchyMap.get(agent.AgentId);
            if (agent.ParentId && hierarchyMap.has(agent.ParentId)) {
              const parent = hierarchyMap.get(agent.ParentId);
              if (!parent.children) parent.children = [];
              parent.children.push(node);
            } else if (agent.Level === 1) {
              rootAgents.push(node);
            }
          });
          
          // Create agency node with agents only if we have root agents
          if (rootAgents.length > 0) {
            const agencyNode: HierarchyNode = {
              id: response.data.agency?.AgencyId || 'agency',
              type: 'agency' as const,
              name: response.data.agency?.AgencyName || 'Your Agency',
              status: response.data.agency?.Status || 'Active',
              agents: rootAgents
            };
            
            setHierarchyData({
              tenant: {
                id: 'agent-view',
                type: 'tenant' as const,
                name: response.data.agency?.AgencyName || 'Your Agency',
                agencies: []
              },
              agencies: [agencyNode]
            });
          } else {
            // Empty state
            setHierarchyData({
              tenant: {
                id: 'agent-view',
                type: 'tenant' as const,
                name: response.data.agency?.AgencyName || 'Your Agency',
                agencies: []
              },
              agencies: []
            });
          }
        } else {
          // TenantAdmin format - use as is
          setHierarchyData(response.data!);
        }
      } else {
        setError(response.message || 'Failed to load hierarchy');
      }
    } catch (err: any) {
      console.error('❌ Error fetching hierarchy:', err);
      setError(err.message || 'Failed to load hierarchy data');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black bg-opacity-50 transition-opacity"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <div className="relative bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-gray-200">
            <div className="flex items-center gap-3">
              <Users className="w-6 h-6 text-oe-primary" />
              <div>
                <h2 className="text-2xl font-semibold text-gray-900">
                  {currentRole === 'Agent' ? 'Downline Hierarchy' : 'Organization Hierarchy'}
                </h2>
                <p className="text-sm text-gray-600 mt-1">
                  {currentRole === 'Agent' 
                    ? 'View your agent downline structure' 
                    : 'View your complete organizational structure'}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {loading && (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
              </div>
            )}

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <div className="flex items-center gap-2">
                  <X className="w-5 h-5 text-red-500" />
                  <span className="text-red-700">{error}</span>
                </div>
              </div>
            )}

            {!loading && !error && hierarchyData && (
              <div className="space-y-4">
                {/* Check if there's any data to show */}
                {hierarchyData.agencies.length === 0 && (!hierarchyData.tenant.agencies || hierarchyData.tenant.agencies.length === 0) ? (
                  <div className="text-center py-12">
                    <Users className="w-16 h-16 text-gray-400 mx-auto mb-4" />
                    <h3 className="text-lg font-medium text-gray-900 mb-2">
                      {currentRole === 'Agent' ? 'No Downline Agents Yet' : 'No Organization Data'}
                    </h3>
                    <p className="text-gray-600">
                      {currentRole === 'Agent' 
                        ? 'You haven\'t recruited any agents yet. Start building your team!' 
                        : 'No hierarchy data available.'}
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Tenant Level */}
                    <HierarchyTreeNode
                      node={{
                        ...hierarchyData.tenant,
                        agencies: hierarchyData.agencies,
                      }}
                      level={0}
                    />
                  </>
                )}
              </div>
            )}

            {!loading && !error && !hierarchyData && (
              <div className="text-center py-12 text-gray-500">
                <Users className="w-12 h-12 mx-auto mb-4 text-gray-400" />
                <p>No hierarchy data available</p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-gray-200 p-4 bg-gray-50">
            <div className="flex items-center justify-between text-sm text-gray-600">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <Building className="w-4 h-4 text-oe-primary" />
                  <span>Tenant</span>
                </div>
                <div className="flex items-center gap-2">
                  <Building className="w-4 h-4 text-gray-700" />
                  <span>Agency</span>
                </div>
                <div className="flex items-center gap-2">
                  <User className="w-4 h-4 text-green-600" />
                  <span>Agent</span>
                </div>
              </div>
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
    </div>
  );
};

export default HierarchyTreeModal;

