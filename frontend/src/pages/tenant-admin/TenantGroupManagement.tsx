// src/pages/tenant-admin/TenantGroupManagement.tsx
import React, { useState, useEffect } from 'react';
import {
  Building2,
  Plus,
  Search,
  Users,
  UserCheck,
  DollarSign,
  TrendingUp,
  MoreVertical,
  Edit,
  UserPlus,
  Eye,
  Activity
} from 'lucide-react';
import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';
import type { 
  TenantGroup, 
  CreateTenantGroupRequest,
  TenantUser 
} from '../../types/tenant-admin/tenant-admin.types';

const TenantGroupManagement: React.FC = () => {
  const [groups, setGroups] = useState<TenantGroup[]>([]);
  const [agents, setAgents] = useState<TenantUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string>('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<TenantGroup | null>(null);
  const [showActionsMenu, setShowActionsMenu] = useState<string | null>(null);

  useEffect(() => {
    loadGroups();
    loadAgents();
  }, [searchTerm, selectedStatus]);

  const loadGroups = async () => {
    try {
      setLoading(true);
      const response = await TenantAdminService.getTenantGroups({
        search: searchTerm || undefined,
        status: selectedStatus || undefined
      });

      if (response.success && response.data) {
        setGroups(response.data as any);
      }
    } catch (error) {
      console.error('Failed to load groups:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadAgents = async () => {
    try {
      const response = await TenantAdminService.getTenantUsers({
        userType: 'Affiliate_Agent',
        status: 'Active'
      });

      if (response.success && response.data) {
        setAgents(response.data as any);
      }
    } catch (error) {
      console.error('Failed to load agents:', error);
    }
  };

  const handleCreateGroup = async (groupData: CreateTenantGroupRequest) => {
    try {
      const response = await TenantAdminService.createTenantGroup(groupData);
      if (response.success) {
        setShowCreateModal(false);
        loadGroups();
      }
    } catch (error) {
      console.error('Failed to create group:', error);
    }
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'Active':
        return 'bg-green-100 text-green-800';
      case 'Inactive':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <button
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-oe-primary hover:bg-oe-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary"
        >
          <Plus className="h-4 w-4 mr-2" />
          Create Group
        </button>
      </div>
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
          <div className="flex items-center">
            <div className="p-2 bg-oe-light rounded-lg">
              <Building2 className="h-6 w-6 text-oe-primary" />
            </div>
            <div className="ml-4">
              <p className="text-2xl font-bold text-oe-neutral-dark">
                {groups.filter(g => g.Status === 'Active').length}
              </p>
              <p className="text-sm text-gray-600">Active Groups</p>
            </div>
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
          <div className="flex items-center">
            <div className="p-2 bg-green-100 rounded-lg">
              <Users className="h-6 w-6 text-oe-success" />
            </div>
            <div className="ml-4">
              <p className="text-2xl font-bold text-oe-neutral-dark">
                {groups.reduce((sum, g) => sum + (g.memberCount || 0), 0)}
              </p>
              <p className="text-sm text-gray-600">Total Members</p>
            </div>
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
          <div className="flex items-center">
            <div className="p-2 bg-purple-100 rounded-lg">
              <UserCheck className="h-6 w-6 text-purple-600" />
            </div>
            <div className="ml-4">
              <p className="text-2xl font-bold text-oe-neutral-dark">
                {groups.reduce((sum, g) => sum + g.ActiveEnrollments, 0)}
              </p>
              <p className="text-sm text-gray-600">Active Enrollments</p>
            </div>
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
          <div className="flex items-center">
            <div className="p-2 bg-orange-100 rounded-lg">
              <DollarSign className="h-6 w-6 text-orange-600" />
            </div>
            <div className="ml-4">
              <p className="text-2xl font-bold text-oe-neutral-dark">
                ${groups.reduce((sum, g) => sum + g.MonthlyPremium, 0).toLocaleString()}
              </p>
              <p className="text-sm text-gray-600">Monthly Premium</p>
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="relative">
            <Search className="h-5 w-5 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search groups..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>
          
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="form-input focus:ring-oe-primary focus:border-oe-primary"
          >
            <option value="">All Statuses</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </select>

          <button
            onClick={loadGroups}
            className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-oe-neutral-light"
          >
            <TrendingUp className="h-4 w-4 mr-2" />
            Refresh
          </button>
        </div>
      </div>

      {/* Groups Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-medium text-oe-neutral-dark">
            Groups ({groups.length})
          </h2>
        </div>

        {loading ? (
          <div className="p-8 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
          </div>
        ) : groups.length === 0 ? (
          <div className="p-8 text-center">
            <Building2 className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-oe-neutral-dark mb-2">No groups found</h3>
            <p className="text-gray-600 mb-4">
              {searchTerm || selectedStatus 
                ? 'Try adjusting your filters' 
                : 'Get started by creating your first group'
              }
            </p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-oe-primary hover:bg-oe-dark"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Group
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-oe-neutral-light">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Group
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Assigned Agent
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Members
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Enrollments
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Monthly Premium
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="relative px-6 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {groups.map((group) => (
                  <tr key={group.GroupId} className="hover:bg-oe-neutral-light">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="p-2 bg-oe-light rounded-lg mr-3">
                          <Building2 className="h-5 w-5 text-oe-primary" />
                        </div>
                        <div>
                          <div className="text-sm font-medium text-oe-neutral-dark">
                            {group.Name}
                          </div>
                          {group.description && (
                            <div className="text-sm text-gray-500">
                              {group.description}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {group.assignedAgentName ? (
                        <div className="text-sm text-oe-neutral-dark">
                          {group.assignedAgentName}
                        </div>
                      ) : (
                        <span className="text-sm text-gray-500 italic">
                          No agent assigned
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center text-sm text-oe-neutral-dark">
                        <Users className="h-4 w-4 mr-1 text-gray-400" />
                        {group.memberCount || 0}
                        {(group.memberCount || 0) > 0 && (
                          <span className="text-xs text-gray-500 ml-1">members</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center text-sm text-oe-neutral-dark">
                        <UserCheck className="h-4 w-4 mr-1 text-gray-400" />
                        {group.ActiveEnrollments}
                        {group.ActiveEnrollments > 0 && (
                          <span className="text-xs text-gray-500 ml-1">active</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-oe-neutral-dark">
                      ${group.MonthlyPremium.toLocaleString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadgeColor(group.Status)}`}>
                        {group.Status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="relative">
                        <button
                          onClick={() => setShowActionsMenu(showActionsMenu === group.GroupId ? null : group.GroupId)}
                          className="text-gray-400 hover:text-gray-500"
                        >
                          <MoreVertical className="h-5 w-5" />
                        </button>
                        
                        {showActionsMenu === group.GroupId && (
                          <div className="absolute right-0 mt-2 w-48 bg-white rounded-md shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none z-10">
                            <div className="py-1">
                              <button
                                onClick={() => setSelectedGroup(group)}
                                className="flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 w-full text-left"
                              >
                                <Eye className="h-4 w-4 mr-2" />
                                View Details
                              </button>
                              
                              <button
                                onClick={() => {/* Handle edit */}}
                                className="flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 w-full text-left"
                              >
                                <Edit className="h-4 w-4 mr-2" />
                                Edit Group
                              </button>
                              
                              {!group.assignedAgentId && (
                                <button
                                  onClick={() => {/* Show assign agent modal */}}
                                  className="flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 w-full text-left"
                                >
                                  <UserPlus className="h-4 w-4 mr-2" />
                                  Assign Agent
                                </button>
                              )}
                              
                              <div className="border-t border-gray-100 my-1"></div>
                              
                              <button
                                onClick={() => {/* Handle view activity */}}
                                className="flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 w-full text-left"
                              >
                                <Activity className="h-4 w-4 mr-2" />
                                View Activity
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Group Modal */}
      {showCreateModal && (
        <CreateGroupModal
          agents={agents}
          onClose={() => setShowCreateModal(false)}
          onSubmit={handleCreateGroup}
        />
      )}

      {/* Group Details Modal */}
      {selectedGroup && (
        <GroupDetailsModal
          group={selectedGroup}
          onClose={() => setSelectedGroup(null)}
        />
      )}
    </div>
  );
};

// Create Group Modal Component  
interface CreateGroupModalProps {
  agents: TenantUser[];
  onClose: () => void;
  onSubmit: (groupData: CreateTenantGroupRequest) => void;
}

const CreateGroupModal: React.FC<CreateGroupModalProps> = ({ 
  agents, 
  onClose, 
  onSubmit 
}) => {
  const [formData, setFormData] = useState<CreateTenantGroupRequest>({
    name: '',
    contactEmail: '',
    description: '',
    assignedAgentId: ''
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-md w-full p-6">
        <h3 className="text-lg font-medium text-oe-neutral-dark mb-4">Create New Group</h3>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Group Name
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              className="w-full form-input focus:ring-oe-primary focus:border-oe-primary"
              placeholder="Enter group name..."
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Contact Email
            </label>
            <input
              type="email"
              value={formData.contactEmail}
              onChange={(e) => setFormData(prev => ({ ...prev, contactEmail: e.target.value }))}
              className="w-full form-input focus:ring-oe-primary focus:border-oe-primary"
              placeholder="Enter contact email..."
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
              rows={3}
              className="w-full form-input focus:ring-oe-primary focus:border-oe-primary"
              placeholder="Optional description..."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Assigned Agent (Optional)
            </label>
            <select
              value={formData.assignedAgentId}
              onChange={(e) => setFormData(prev => ({ ...prev, assignedAgentId: e.target.value }))}
              className="w-full form-input focus:ring-oe-primary focus:border-oe-primary"
            >
              <option value="">No agent assigned</option>
              {agents.map((agent) => (
                <option key={agent.userId} value={agent.userId}>
                  {agent.firstName} {agent.lastName}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end space-x-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-oe-neutral-light"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm font-medium text-white bg-oe-primary border border-transparent rounded-md hover:bg-oe-dark"
            >
              Create Group
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// Group Details Modal Component
interface GroupDetailsModalProps {
  group: TenantGroup;
  onClose: () => void;
}

const GroupDetailsModal: React.FC<GroupDetailsModalProps> = ({ 
  group, 
  onClose 
}) => {
  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'Active':
        return 'bg-green-100 text-green-800';
      case 'Inactive':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-2xl w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-oe-neutral-dark">
            {group.Name} - Group Details
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
            ×
          </button>
        </div>
        
        <div className="space-y-6">
          {/* Basic Info */}
          <div>
            <h4 className="text-sm font-medium text-oe-neutral-dark mb-2">Basic Information</h4>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Group Name:</span>
                <span className="ml-2 font-medium">{group.Name}</span>
              </div>
              <div>
                <span className="text-gray-500">Status:</span>
                <span className={`ml-2 px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadgeColor(group.Status)}`}>
                  {group.Status}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Created:</span>
                <span className="ml-2 font-medium">
                  {new Date(group.CreatedDate).toLocaleDateString()}
                </span>
              </div>
              {group.lastActivityDate && (
                <div>
                  <span className="text-gray-500">Last Activity:</span>
                  <span className="ml-2 font-medium">
                    {new Date(group.lastActivityDate).toLocaleDateString()}
                  </span>
                </div>
              )}
            </div>
            {group.description && (
              <div className="mt-3">
                <span className="text-gray-500">Description:</span>
                <p className="mt-1 text-sm text-oe-neutral-dark">{group.description}</p>
              </div>
            )}
          </div>

          {/* Assignment Info */}
          <div>
            <h4 className="text-sm font-medium text-oe-neutral-dark mb-2">Assignment</h4>
            <div className="text-sm">
              {group.assignedAgentName ? (
                <div>
                  <span className="text-gray-500">Assigned Agent:</span>
                  <span className="ml-2 font-medium">{group.assignedAgentName}</span>
                </div>
              ) : (
                <span className="text-gray-500 italic">No agent assigned</span>
              )}
            </div>
          </div>

          {/* Performance Metrics */}
          <div>
            <h4 className="text-sm font-medium text-oe-neutral-dark mb-2">Performance Metrics</h4>
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-oe-neutral-light p-3 rounded-lg text-center">
                <div className="text-2xl font-bold text-oe-neutral-dark">{group.memberCount || 0}</div>
                <div className="text-xs text-gray-500">Members</div>
              </div>
              <div className="bg-oe-neutral-light p-3 rounded-lg text-center">
                <div className="text-2xl font-bold text-oe-neutral-dark">{group.ActiveEnrollments}</div>
                <div className="text-xs text-gray-500">Active Enrollments</div>
              </div>
              <div className="bg-oe-neutral-light p-3 rounded-lg text-center">
                <div className="text-2xl font-bold text-oe-neutral-dark">${group.MonthlyPremium.toLocaleString()}</div>
                <div className="text-xs text-gray-500">Monthly Premium</div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end pt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-oe-neutral-light"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default TenantGroupManagement;