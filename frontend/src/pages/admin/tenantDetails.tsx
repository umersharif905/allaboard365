// File: src/pages/admin/tenantDetails.tsx
// Enhanced Tenant Details Modal Component with User Management - FIXED TYPESCRIPT ERROR
import {
    Activity, DollarSign,
    Edit,
    Globe,
    Mail,
    MapPin,
    MoreHorizontal,
    Phone,
    Search,
    Shield,
    UserCheck,
    UserPlus,
    Users,
    X
} from 'lucide-react';
import React, { useEffect, useState, useCallback } from 'react';
import { getErrorMessage } from '../../utils/helpers'; // Import the utility function
import { ExtendedTenant } from './tenants';
import { apiService } from '../../services/api.service';
import type { ApiResponse } from '../../types/api.types';

interface TenantDetailsProps {
  tenant: ExtendedTenant;
  onClose: () => void;
  onEdit: () => void;
  formatCurrency: (amount: number) => string;
}

interface TenantUser {
  UserId: string;
  FirstName: string;
  LastName: string;
  Email: string;
  PhoneNumber?: string;
  roles: string[];
  Status: string;
  CreatedDate: string;
  LastLoginDate?: string;
}

interface CreateUserData {
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber?: string;
  sendWelcomeEmail: boolean;
}

const TenantDetails: React.FC<TenantDetailsProps> = ({ 
  tenant, 
  onClose, 
  onEdit,
  formatCurrency 
}) => {
  // State management - ADDED USER MANAGEMENT STATE
  const [activeTab, setActiveTab] = useState<'overview' | 'users'>('overview');
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [showCreateUserModal, setShowCreateUserModal] = useState(false);
  const [userSearchTerm, setUserSearchTerm] = useState('');
  const [selectedRole, setSelectedRole] = useState('');

  // ADDED: Fetch users for this tenant (excluding Members)
  const fetchTenantUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const response = await apiService.get<ApiResponse<TenantUser[]>>(`/api/users?tenantId=${tenant.TenantId}`);
      
      if (response.success && response.data) {
        // Map backend response to TenantUser interface
        const mappedUsers: TenantUser[] = response.data.map((user: any) => ({
          UserId: user.UserId,
          FirstName: user.FirstName,
          LastName: user.LastName,
          Email: user.Email,
          PhoneNumber: user.PhoneNumber,
          roles: user.roles || [],
          Status: user.Status,
          CreatedDate: user.CreatedDate,
          LastLoginDate: user.LastLoginDate
        }));
        
        // Filter out Members - only show Agents, GroupAdmins, TenantAdmins
        const filteredUsers = mappedUsers.filter((user: TenantUser) => 
          user.roles && user.roles.length > 0 && !user.roles.includes('Member')
        );
        setUsers(filteredUsers);
        console.log(`✅ Loaded ${filteredUsers.length} users for tenant ${tenant.Name} (out of ${mappedUsers.length} total)`);
      } else {
        console.error('Failed to fetch users:', response.message || 'Unknown error');
        setUsers([]);
      }
    } catch (error) {
      console.error('Error fetching users:', error);
      setUsers([]);
    } finally {
      setLoadingUsers(false);
    }
  }, [tenant.TenantId, tenant.Name]);

  // ADDED: Load users when switching to users tab
  useEffect(() => {
    if (activeTab === 'users') {
      fetchTenantUsers();
    }
  }, [activeTab, fetchTenantUsers]);

  // UPDATED: Create new user with Agent record creation - FIXED ERROR HANDLING
  const handleCreateUser = async (userData: CreateUserData) => {
    try {
      const token = localStorage.getItem('accessToken') || localStorage.getItem('token');
      const response = await fetch('/api/users', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ...userData,
          tenantId: tenant.TenantId
        })
      });
      
      const result = await response.json();
      if (result.success) {
        setShowCreateUserModal(false);
        fetchTenantUsers(); // Refresh the user list
        
        console.log('✅ User created successfully:', result.message);
        if (result.data.agentId) {
          console.log('✅ Agent record created with ID:', result.data.agentId);
        }
      } else {
        console.error('Failed to create user:', result.message);
        // Only show alert for actual errors, not success
        alert(`Failed to create user: ${result.message}`);
      }
    } catch (error) {
      console.error('Error creating user:', error);
      alert(`Error creating user: ${getErrorMessage(error)}`); // FIXED: Use utility function
    }
  };

  // ADDED: Filter users based on search and role (excluding Members)
  const filteredUsers = users.filter(user => {
    // Ensure we never show Members (double-check filtering)
    if (user.roles && user.roles.includes('Member')) return false;
    
    const matchesSearch = user.FirstName.toLowerCase().includes(userSearchTerm.toLowerCase()) ||
                         user.LastName.toLowerCase().includes(userSearchTerm.toLowerCase()) ||
                         user.Email.toLowerCase().includes(userSearchTerm.toLowerCase());
    const matchesRole = !selectedRole || (user.roles && user.roles.includes(selectedRole));
    return matchesSearch && matchesRole;
  });

  // ORIGINAL FUNCTION - KEPT UNCHANGED
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Active':
        return 'bg-green-100 text-green-800';
      case 'Suspended':
        return 'bg-red-100 text-red-800';
      case 'Pending':
        return 'bg-yellow-100 text-yellow-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  // ADDED: Role colors
  const getRoleColor = (role: string) => {
    switch (role) {
      case 'Agent':
        return 'bg-blue-100 text-blue-800';
      case 'GroupAdmin':
        return 'bg-purple-100 text-purple-800';
      case 'TenantAdmin':
        return 'bg-orange-100 text-orange-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-6xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          {/* ORIGINAL HEADER - KEPT UNCHANGED */}
          <div className="flex justify-between items-start mb-6">
            <div className="flex items-center gap-4">
              <div 
                className="w-16 h-16 rounded-lg flex items-center justify-center text-white font-bold text-2xl"
                style={{ backgroundColor: tenant.PrimaryColorHex || '#1f6db0' }}
              >
                {tenant.Name.charAt(0)}
              </div>
              <div>
                <h2 className="text-2xl font-bold text-oe-neutral-dark">{tenant.Name}</h2>
                <p className="text-gray-600">{tenant.ContactEmail}</p>
                <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(tenant.Status)}`}>
                  {tenant.Status}
                </span>
              </div>
            </div>
            <button 
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
            >
              <X size={24} />
            </button>
          </div>

          {/* ADDED: Tabs Navigation */}
          <div className="flex space-x-6 mb-6 border-b border-gray-200">
            <button
              onClick={() => setActiveTab('overview')}
              className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${
                activeTab === 'overview'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setActiveTab('users')}
              className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors ${
                activeTab === 'users'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Users {loadingUsers ? '(loading...)' : `(${users.length})`}
            </button>
          </div>

          {/* ORIGINAL OVERVIEW TAB - KEPT EXACTLY THE SAME */}
          {activeTab === 'overview' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Company Information */}
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Company Information</h3>
                  <div className="space-y-3">
                    <div>
                      <label className="text-sm font-medium text-gray-700">Company Name</label>
                      <p className="text-oe-neutral-dark">{tenant.Name}</p>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-gray-700">Contact Email</label>
                      <p className="text-oe-neutral-dark">{tenant.ContactEmail}</p>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-gray-700">Contact Phone</label>
                      <p className="text-oe-neutral-dark">{tenant.ContactPhone || 'Not provided'}</p>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-gray-700">Website</label>
                      <p className="text-oe-neutral-dark">{tenant.Website || 'Not provided'}</p>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-gray-700">Custom Domain</label>
                      <p className="text-oe-neutral-dark">{tenant.CustomDomain || 'Not configured'}</p>
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Address Information</h3>
                  <div className="space-y-3">
                    <div>
                      <label className="text-sm font-medium text-gray-700">Address</label>
                      <p className="text-oe-neutral-dark">{tenant.PrimaryAddress || 'Not provided'}</p>
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                      <div>
                        <label className="text-sm font-medium text-gray-700">City</label>
                        <p className="text-oe-neutral-dark">{tenant.PrimaryCity || 'Not provided'}</p>
                      </div>
                      <div>
                        <label className="text-sm font-medium text-gray-700">State</label>
                        <p className="text-oe-neutral-dark">{tenant.PrimaryState || 'Not provided'}</p>
                      </div>
                      <div>
                        <label className="text-sm font-medium text-gray-700">ZIP Code</label>
                        <p className="text-oe-neutral-dark">{tenant.PrimaryZip || 'Not provided'}</p>
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Branding</h3>
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm font-medium text-gray-700">Primary Color</label>
                        <div className="flex items-center gap-2">
                          <div 
                            className="w-6 h-6 rounded border"
                            style={{ backgroundColor: tenant.PrimaryColorHex || '#1f6db0' }}
                          ></div>
                          <p className="text-oe-neutral-dark">{tenant.PrimaryColorHex || '#1f6db0'}</p>
                        </div>
                      </div>
                      <div>
                        <label className="text-sm font-medium text-gray-700">Secondary Color</label>
                        <div className="flex items-center gap-2">
                          <div 
                            className="w-6 h-6 rounded border"
                            style={{ backgroundColor: tenant.SecondaryColorHex || '#424242' }}
                          ></div>
                          <p className="text-oe-neutral-dark">{tenant.SecondaryColorHex || '#424242'}</p>
                        </div>
                      </div>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-gray-700">Logo URL</label>
                      <p className="text-oe-neutral-dark">{tenant.LogoUrl || 'Not uploaded'}</p>
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Additional Details</h3>
                  <div className="space-y-3">
                    <div>
                      <label className="text-sm font-medium text-gray-700">Tax ID Number</label>
                      <p className="text-oe-neutral-dark">{tenant.TaxIdNumber || 'Not provided'}</p>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-gray-700">Time Zone</label>
                      <p className="text-oe-neutral-dark">{tenant.TimeZone || 'Not set'}</p>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-gray-700">Description</label>
                      <p className="text-oe-neutral-dark">{tenant.Description || 'No description provided'}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm font-medium text-gray-700">Created Date</label>
                        <p className="text-oe-neutral-dark">{new Date(tenant.CreatedDate).toLocaleDateString()}</p>
                      </div>
                      <div>
                        <label className="text-sm font-medium text-gray-700">Last Modified</label>
                        <p className="text-oe-neutral-dark">{new Date(tenant.ModifiedDate).toLocaleDateString()}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Statistics and Metrics - KEPT EXACTLY THE SAME */}
              <div>
                <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Performance Metrics</h3>
                
                {/* Key Metrics */}
                <div className="grid grid-cols-2 gap-4 mb-6">
                  <div className="bg-oe-light p-4 rounded-lg">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-oe-primary">Total Members</p>
                        <p className="text-2xl font-bold text-oe-dark">{tenant.TotalMembers.toLocaleString()}</p>
                      </div>
                      <Users className="text-oe-primary" size={24} />
                    </div>
                  </div>
                  
                  <div className="bg-green-50 p-4 rounded-lg">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-oe-success">Active Members</p>
                        <p className="text-2xl font-bold text-green-900">{tenant.ActiveMembers.toLocaleString()}</p>
                      </div>
                      <Activity className="text-oe-success" size={24} />
                    </div>
                  </div>
                  
                  <div className="bg-purple-50 p-4 rounded-lg">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-purple-600">Monthly Revenue</p>
                        <p className="text-2xl font-bold text-purple-900">{formatCurrency(tenant.MonthlyRevenue)}</p>
                      </div>
                      <DollarSign className="text-purple-600" size={24} />
                    </div>
                  </div>
                  
                  <div className="bg-orange-50 p-4 rounded-lg">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-orange-600">Total Agents</p>
                        <p className="text-2xl font-bold text-orange-900">{tenant.TotalAgents}</p>
                      </div>
                      <Shield className="text-orange-600" size={24} />
                    </div>
                  </div>
                </div>

                {/* Additional Metrics - KEPT EXACTLY THE SAME */}
                <div className="space-y-4">
                  <div className="border border-gray-200 rounded-lg p-4">
                    <h4 className="font-medium text-oe-neutral-dark mb-3">Product Subscriptions</h4>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-gray-600">Subscribed Products</p>
                        <p className="text-lg font-semibold">{tenant.SubscribedProducts} of {tenant.TotalProducts}</p>
                      </div>
                      <div className="w-24 bg-gray-200 rounded-full h-2">
                        <div 
                          className="bg-oe-primary h-2 rounded-full"
                          style={{ 
                            width: `${(tenant.SubscribedProducts / tenant.TotalProducts) * 100}%` 
                          }}
                        ></div>
                      </div>
                    </div>
                  </div>

                  <div className="border border-gray-200 rounded-lg p-4">
                    <h4 className="font-medium text-oe-neutral-dark mb-3">Member Activity</h4>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-gray-600">Active Rate</p>
                        <p className="text-lg font-semibold">
                          {((tenant.ActiveMembers / tenant.TotalMembers) * 100).toFixed(1)}%
                        </p>
                      </div>
                      <div className="w-24 bg-gray-200 rounded-full h-2">
                        <div 
                          className="bg-oe-success h-2 rounded-full"
                          style={{ 
                            width: `${(tenant.ActiveMembers / tenant.TotalMembers) * 100}%` 
                          }}
                        ></div>
                      </div>
                    </div>
                  </div>

                  <div className="border border-gray-200 rounded-lg p-4">
                    <h4 className="font-medium text-oe-neutral-dark mb-3">Revenue Metrics</h4>
                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <span className="text-sm text-gray-600">Revenue per Member</span>
                        <span className="font-medium">
                          {formatCurrency(tenant.MonthlyRevenue / tenant.ActiveMembers)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-gray-600">Revenue per Agent</span>
                        <span className="font-medium">
                          {formatCurrency(tenant.MonthlyRevenue / tenant.TotalAgents)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-gray-600">Annual Revenue (Est.)</span>
                        <span className="font-medium">
                          {formatCurrency(tenant.MonthlyRevenue * 12)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Quick Contact Info - KEPT EXACTLY THE SAME */}
                  <div className="border border-gray-200 rounded-lg p-4">
                    <h4 className="font-medium text-oe-neutral-dark mb-3">Quick Contact</h4>
                    <div className="space-y-2">
                      <div className="flex items-center text-sm">
                        <Mail size={14} className="mr-2 text-gray-500" />
                        <span className="text-gray-600">{tenant.ContactEmail}</span>
                      </div>
                      {tenant.ContactPhone && (
                        <div className="flex items-center text-sm">
                          <Phone size={14} className="mr-2 text-gray-500" />
                          <span className="text-gray-600">{tenant.ContactPhone}</span>
                        </div>
                      )}
                      <div className="flex items-center text-sm">
                        <MapPin size={14} className="mr-2 text-gray-500" />
                        <span className="text-gray-600">
                          {tenant.PrimaryCity}, {tenant.PrimaryState} {tenant.PrimaryZip}
                        </span>
                      </div>
                      {tenant.Website && (
                        <div className="flex items-center text-sm">
                          <Globe size={14} className="mr-2 text-gray-500" />
                          <a href={tenant.Website} target="_blank" rel="noopener noreferrer" 
                             className="text-oe-primary hover:underline">
                            {tenant.Website}
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-6">
                  <button 
                    onClick={onEdit}
                    className="w-full bg-oe-primary text-white py-2 px-4 rounded-md font-medium hover:bg-oe-dark transition-colors"
                  >
                    Edit Tenant
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ADDED: Users Tab - NEW FUNCTIONALITY */}
          {activeTab === 'users' && (
            <div>
              {/* Users Header */}
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h3 className="text-lg font-semibold text-oe-neutral-dark">User Management</h3>
                  <p className="text-gray-600">Manage users within this tenant organization</p>
                </div>
                <button
                  onClick={() => setShowCreateUserModal(true)}
                  className="flex items-center px-4 py-2 bg-oe-primary text-white rounded-md hover:bg-oe-dark transition-colors"
                >
                  <UserPlus className="h-4 w-4 mr-2" />
                  Add User
                </button>
              </div>

              {/* Users Filters */}
              <div className="flex flex-col sm:flex-row gap-4 mb-6">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search users..."
                    value={userSearchTerm}
                    onChange={(e) => setUserSearchTerm(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                  />
                </div>
                <div className="px-3 py-2 bg-gray-50 border border-gray-300 rounded-md text-sm text-gray-600">
                  All User Types (Agents, Group Admins, Tenant Admins)
                </div>
              </div>

              {/* Users Table */}
              <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                {loadingUsers ? (
                  <div className="p-8 text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto"></div>
                    <p className="mt-2 text-gray-600">Loading users...</p>
                  </div>
                ) : filteredUsers.length === 0 ? (
                  <div className="p-8 text-center">
                    <UserCheck className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                    <p className="text-gray-600">No users found</p>
                    <p className="text-sm text-gray-500">
                      {userSearchTerm || selectedRole ? 'Try adjusting your filters' : 'Add your first user to get started'}
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            User
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Role
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Status
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Last Login
                          </th>
                          <th className="relative px-6 py-3">
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {filteredUsers.map((user) => (
                          <tr key={user.UserId} className="hover:bg-gray-50">
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="flex items-center">
                                <div className="w-10 h-10 bg-oe-light rounded-full flex items-center justify-center">
                                  <span className="text-oe-primary font-medium text-sm">
                                    {user.FirstName.charAt(0)}{user.LastName.charAt(0)}
                                  </span>
                                </div>
                                <div className="ml-4">
                                  <div className="text-sm font-medium text-oe-neutral-dark">
                                    {user.FirstName} {user.LastName}
                                  </div>
                                  <div className="text-sm text-gray-500">{user.Email}</div>
                                  {user.PhoneNumber && (
                                    <div className="text-sm text-gray-500">{user.PhoneNumber}</div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="flex flex-wrap gap-1">
                                {user.roles && user.roles.map((role, index) => (
                                  <span key={index} className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getRoleColor(role)}`}>
                                    {role}
                                    {role === 'Agent' && (
                                      <span className="ml-1" title="Agent record created - can be assigned to groups">
                                        ✓
                                      </span>
                                    )}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getStatusColor(user.Status)}`}>
                                {user.Status}
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                              {user.LastLoginDate 
                                ? new Date(user.LastLoginDate).toLocaleDateString()
                                : 'Never'
                              }
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                              <div className="flex items-center space-x-2">
                                <button
                                  className="text-oe-primary hover:text-oe-dark p-1 rounded"
                                  title="Edit User"
                                >
                                  <Edit className="h-4 w-4" />
                                </button>
                                <button
                                  className="text-gray-600 hover:text-gray-900 p-1 rounded"
                                  title="More Actions"
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ADDED: Create User Modal */}
      {showCreateUserModal && (
        <CreateUserModal
          onClose={() => setShowCreateUserModal(false)}
          onSubmit={handleCreateUser}
          tenantName={tenant.Name}
        />
      )}
    </div>
  );
};

// UPDATED: Create User Modal Component with Agent creation feedback
interface CreateUserModalProps {
  onClose: () => void;
  onSubmit: (userData: CreateUserData) => void;
  tenantName: string;
}

const CreateUserModal: React.FC<CreateUserModalProps> = ({ onClose, onSubmit, tenantName }) => {
  const [formData, setFormData] = useState<CreateUserData>({
    firstName: '',
    lastName: '',
    email: '',
    phoneNumber: '',
    sendWelcomeEmail: true
  });

  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    
    try {
      await onSubmit(formData);
    } catch (error) {
      console.error('Error submitting form:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[60]">
      <div className="bg-white rounded-lg max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-oe-neutral-dark">Add User to {tenantName}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
            <X className="h-5 w-5" />
          </button>
        </div>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                First Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={formData.firstName}
                onChange={(e) => setFormData(prev => ({ ...prev, firstName: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                required
                disabled={isSubmitting}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Last Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={formData.lastName}
                onChange={(e) => setFormData(prev => ({ ...prev, lastName: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                required
                disabled={isSubmitting}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email Address <span className="text-red-500">*</span>
            </label>
            <input
              type="email"
              value={formData.email}
              onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
              required
              disabled={isSubmitting}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Phone Number
            </label>
            <input
              type="tel"
              value={formData.phoneNumber}
              onChange={(e) => setFormData(prev => ({ ...prev, phoneNumber: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
              placeholder="(555) 123-4567"
              disabled={isSubmitting}
            />
          </div>

          {/* Role is automatically set to Agent for tenant user management */}
          <div className="bg-gray-50 p-3 rounded-md">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              User Role
            </label>
            <div className="text-sm text-gray-600">
              Agent (automatically assigned)
            </div>
            <p className="text-xs text-oe-primary font-medium mt-1">
              ✓ Will create Agent record for selling products and managing groups
            </p>
          </div>

          <div className="flex items-center">
            <input
              type="checkbox"
              id="sendWelcomeEmail"
              checked={formData.sendWelcomeEmail}
              onChange={(e) => setFormData(prev => ({ ...prev, sendWelcomeEmail: e.target.checked }))}
              className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
              disabled={isSubmitting}
            />
            <label htmlFor="sendWelcomeEmail" className="ml-2 block text-sm text-gray-700">
              Send welcome email with login instructions
            </label>
          </div>

          <div className="flex justify-end space-x-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!formData.firstName || !formData.lastName || !formData.email || isSubmitting}
              className="px-4 py-2 text-sm font-medium text-white bg-oe-primary border border-transparent rounded-md hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
            >
              {isSubmitting ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Creating...
                </>
              ) : (
                'Create Agent'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default TenantDetails;