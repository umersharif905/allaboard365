// FILE PATH: frontend/src/pages/admin/groups.tsx
// FIXED VERSION with proper URL handling and enhanced debugging

import { Alert, Snackbar } from '@mui/material';
import {
  Building,
  DollarSign,
  Edit,
  Plus,
  Settings, UserCheck,
  Users
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SharedHeader from '../../components/layout/SharedHeader';
import { apiService } from '../../services/apiServices';
import { Group, GroupsService } from '../../services/groups.service';
import GroupsAddGroup from '../groups/GroupsAddGroup';
import GroupsContributions from './GroupsContributions';

interface Product {
  ProductId: string;
  Name: string;
  ProductType: string;
}

// Standard API envelope returned by makeApiCall (via apiService). Permissive
// index signature covers endpoint-specific fields beyond the common ones.
interface ApiResponse {
  success?: boolean;
  data?: any;
  message?: string;
  [key: string]: any;
}

// Main Groups Page Component
const GroupsPage: React.FC = () => {
  const navigate = useNavigate();
  
  // State management
  const [groups, setGroups] = useState<Group[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [tenants, setTenants] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  
  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showContributionModal, setShowContributionModal] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  
  // Navigation state - DEFAULT OPEN
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Toast notification state
  const [toast, setToast] = useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'warning' | 'info';
  }>({
    open: false,
    message: '',
    severity: 'success'
  });

  // Show toast notification
  const showToast = (message: string, severity: 'success' | 'error' | 'warning' | 'info' = 'success') => {
    setToast({ open: true, message, severity });
  };

  // Close toast notification
  const handleCloseToast = () => {
    setToast(prev => ({ ...prev, open: false }));
  };

  // Enhanced API call function with better error handling - now using apiService
  const makeApiCall = async (endpoint: string, options: { method?: string; body?: any } = {}) => {
    try {
      console.log(`🌐 Making API call to: ${endpoint}`);
      
      let result: ApiResponse;
      const method = options.method?.toUpperCase() || 'GET';

      switch (method) {
        case 'GET':
          result = await apiService.get<ApiResponse>(endpoint);
          break;
        case 'POST':
          result = await apiService.post<ApiResponse>(endpoint, options.body);
          break;
        case 'PUT':
          result = await apiService.put<ApiResponse>(endpoint, options.body);
          break;
        case 'DELETE':
          result = await apiService.delete<ApiResponse>(endpoint);
          break;
        case 'PATCH':
          result = await apiService.patch<ApiResponse>(endpoint, options.body);
          break;
        default:
          throw new Error(`Unsupported HTTP method: ${method}`);
      }
      
      console.log(`✅ API Success for ${endpoint}:`, result);
      return result;

    } catch (error: any) {
      console.error(`❌ API Call failed for ${endpoint}:`, error);
      throw error;
    }
  };

  // Handlers
  const handleLogout = () => {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('token');
    navigate('/login');
  };
  
  const handleSearch = (searchTerm: string) => {
    setSearchTerm(searchTerm);
  };

  // Fetch data on component mount
  useEffect(() => {
    const token = localStorage.getItem('accessToken') || localStorage.getItem('token');
    console.log('Token available:', !!token);
    
    fetchGroups();
    fetchTenants();
    fetchAgents();
    fetchProducts();
  }, []);

  const fetchGroups = async () => {
    try {
      setLoading(true);
      const result = await makeApiCall('/groups');
      
      if (result.success) {
        setGroups(result.data);
        console.log('Groups loaded:', result.data.length);
      } else {
        console.error('Failed to fetch groups:', result.message);
        setGroups([]);
      }
    } catch (error) {
      console.error('Error fetching groups:', error);
      setGroups([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchTenants = async () => {
    try {
      const result = await makeApiCall('/admin/tenants');
      
      if (result.success) {
        setTenants(result.data);
        console.log('Tenants loaded:', result.data.length);
      } else {
        console.error('Failed to fetch tenants:', result.message);
      }
    } catch (error) {
      console.error('Error fetching tenants:', error);
    }
  };

  const fetchAgents = async () => {
    try {
      // Try multiple endpoints for agents
      const agentEndpoints = [
        '/users?userType=Agent',
        '/admin/users?userType=Agent', 
        '/tenant-admin/agents'
      ];

      let result = null;
      for (const endpoint of agentEndpoints) {
        try {
          result = await makeApiCall(endpoint);
          if (result.success && result.data) {
            console.log(`✅ Agents loaded from ${endpoint}:`, result.data.length);
            break;
          }
        } catch (error) {
          console.log(`❌ Failed to fetch agents from ${endpoint}:`, error);
          continue;
        }
      }

      if (result && result.success) {
        setAgents(result.data);
      } else {
        console.error('Failed to fetch agents from all endpoints');
        setAgents([]);
      }
    } catch (error) {
      console.error('Error fetching agents:', error);
      setAgents([]);
    }
  };

  const fetchProducts = async () => {
    try {
      const result = await makeApiCall('/admin/products');
      
      if (result.success) {
        setProducts(result.data);
        console.log('Products loaded:', result.data.length);
      } else {
        console.error('Failed to fetch products:', result.message);
      }
    } catch (error) {
      console.error('Error fetching products:', error);
    }
  };

  // Enhanced create/edit group handler
  const handleCreateGroup = async (groupData: any) => {
    try {
      const requestData = {
        // Basic fields
        name: groupData.name,
        primaryContact: groupData.primaryContact,
        contactEmail: groupData.contactEmail,
        contactPhone: groupData.contactPhone,
        tenantId: groupData.tenantId,
        agentId: groupData.agentId || null,
        
        // Address fields
        address: groupData.address,
        address2: groupData.address2,
        city: groupData.city,
        state: groupData.state,
        zip: groupData.zip,
        
        // Extended contact fields
        contactTitle: groupData.contactTitle,
        contactPhone2: groupData.contactPhone2,
        faxNumber: groupData.faxNumber,
        website: groupData.website,
        
        // Business fields
        taxIdNumber: groupData.taxIdNumber,
        businessType: groupData.businessType,
        
        // Payment fields - Credit Card (send full numbers)
        creditCardNumber: groupData.creditCardNumber,
        creditCardType: groupData.creditCardType,
        creditCardExpiry: groupData.creditCardExpiry,
        creditCardName: groupData.creditCardName,
        
        // Payment fields - ACH (send full numbers)
        achBankName: groupData.achBankName,
        achAccountType: groupData.achAccountType,
        achRoutingNumber: groupData.achRoutingNumber,
        achAccountNumber: groupData.achAccountNumber,
        achAccountName: groupData.achAccountName
      };
      
      console.log(`${groupData.mode === 'edit' ? 'Updating' : 'Creating'} group with data:`, requestData);
      
      const isEdit = groupData.mode === 'edit';
      const endpoint = isEdit ? `/groups/${groupData.groupId}` : '/groups';
      const method = isEdit ? 'PUT' : 'POST';
      
      const result = await makeApiCall(endpoint, {
        method,
        body: JSON.stringify(requestData)
      });
      
      if (result.success) {
        // Handle logo upload if provided
        if (groupData.logoFile) {
          const groupId = isEdit ? groupData.groupId : result.data.groupId;
          await handleLogoUpload(groupId, groupData.logoFile);
        }

        // Persist vendor network selections (per-vendor) for the group.
        // null/missing => use vendor default. The backend resolver picks the variant at view/print time.
        if (groupData.vendorNetworkSelections && typeof groupData.vendorNetworkSelections === 'object') {
          const groupId = isEdit ? groupData.groupId : result.data?.groupId;
          if (groupId) {
            try {
              await apiService.put(`/api/groups/${groupId}/vendor-networks`, {
                selections: groupData.vendorNetworkSelections
              });
            } catch (vnErr) {
              console.error('❌ Failed to save vendor network selections:', vnErr);
            }
          }
        }

        if (!isEdit && groupData.initialEnrollmentPeriod) {
          const groupId = result.data?.groupId || result.data?.GroupId;
          if (groupId) {
            try {
              const periodResult = await GroupsService.applyInitialEnrollmentPeriodAfterGroupCreate(
                groupId,
                groupData.initialEnrollmentPeriod
              );
              if (!periodResult.success) {
                showToast(
                  `Group created but enrollment period could not be set: ${periodResult.message || 'Unknown error'}`,
                  'error'
                );
              }
            } catch (periodErr) {
              console.error('❌ Failed to set initial enrollment period:', periodErr);
              showToast('Group created but enrollment period could not be set.', 'error');
            }
          }
        }

        console.log(`✅ Group ${isEdit ? 'updated' : 'created'} successfully:`, result.message);
        setShowCreateModal(false);
        setShowEditModal(false);
        fetchGroups();
        showToast(`Group ${isEdit ? 'updated' : 'created'} successfully!`, 'success');
      } else {
        console.error(`❌ Failed to ${isEdit ? 'update' : 'create'} group:`, result.message);
        showToast(`Failed to ${isEdit ? 'update' : 'create'} group: ${result.message}`, 'error');
      }
    } catch (error) {
      console.error(`❌ Error ${groupData.mode === 'edit' ? 'updating' : 'creating'} group:`, error);
      showToast(`Error ${groupData.mode === 'edit' ? 'updating' : 'creating'} group. Please try again.`, 'error');
    }
  };

  // Fetch detailed group data for editing
  const fetchGroupDetails = async (groupId: string) => {
    try {
      const result = await makeApiCall(`/groups/${groupId}`);
      
      if (result.success) {
        console.log('✅ Fetched full group details for editing:', result.data);
        return result.data;
      } else {
        console.error('❌ Failed to fetch group details:', result.message);
        return null;
      }
    } catch (error) {
      console.error('❌ Error fetching group details:', error);
      return null;
    }
  };

  // Logo upload handler
  const handleLogoUpload = async (groupId: string, logoFile: File) => {
    try {
      const formData = new FormData();
      formData.append('files', logoFile);
      formData.append('uploadType', 'group-logo');
      formData.append('entityId', groupId);
      
      const result = await apiService.post<{ success: boolean; url?: string; data?: any; message?: string }>('/uploads', formData);
      console.log('📤 Upload response:', result);
      
      if (result.success) {
        console.log('✅ Logo uploaded successfully');
        
        // Handle different response formats from the backend
        let logoUrl = null;
        if (result.url) {
          logoUrl = result.url;
        } else if (result.data && Array.isArray(result.data) && result.data[0]?.url) {
          logoUrl = result.data[0].url;
        } else if (result.data && result.data.url) {
          logoUrl = result.data.url;
        }
        
        if (logoUrl) {
          await updateGroupLogo(groupId, logoUrl);
        } else {
          console.error('❌ No logo URL found in response');
        }
      } else {
        console.error('❌ Failed to upload logo:', result.message);
      }
    } catch (error) {
      console.error('❌ Error uploading logo:', error);
    }
  };

  // Update group logo
  const updateGroupLogo = async (groupId: string, logoUrl: string) => {
    try {
      const result = await makeApiCall(`/groups/${groupId}`, {
        method: 'PUT',
        body: JSON.stringify({ logoUrl })
      });
      
      if (result.success) {
        console.log('✅ Group logo URL updated');
      } else {
        console.warn('⚠️ Logo URL field not supported in Groups table, storing in FileUploads instead');
        console.log('Backend response:', result);
      }
    } catch (error) {
      console.error('❌ Error updating group logo:', error);
    }
  };

  const handleContributionSettings = (group: Group) => {
    setSelectedGroup(group);
    setShowContributionModal(true);
  };

  // Filter groups based on search and status
  const filteredGroups = groups.filter(group => {
    const matchesSearch = group.Name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         group.PrimaryContact?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         group.ContactEmail?.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesStatus = statusFilter === '' || group.Status === statusFilter;
    
    return matchesSearch && matchesStatus;
  });

  if (loading) {
    return (
      <div className="flex h-screen bg-gray-50">
        {/* <AdminNavigation 
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          onLogout={handleLogout}
        /> */}
        <div className="flex-1 flex flex-col">
          <SharedHeader 
            title="Groups Management"
            onSearch={handleSearch}
            showSearch={true}
            showNotifications={true}
          />
          <div className="flex-1 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* <AdminNavigation 
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        onLogout={handleLogout}
      /> */}

      <div className="flex-1 flex flex-col">
        <SharedHeader 
          title="Groups Management"
          onSearch={handleSearch}
          showSearch={true}
          showNotifications={true}
        />
        
        <div className="flex-1 overflow-auto p-6">
          {/* Quick Stats */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
            <div className="bg-white rounded-lg p-6 shadow">
              <div className="flex items-center">
                <div className="p-2 bg-oe-light rounded-lg">
                  <Building className="h-5 w-5 text-oe-primary" />
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-600">Total Groups</p>
                  <p className="text-2xl font-bold text-gray-900">{groups.length}</p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg p-6 shadow">
              <div className="flex items-center">
                <div className="p-2 bg-green-100 rounded-lg">
                  <Users className="h-5 w-5 text-oe-success" />
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-600">Total Members</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {groups.reduce((sum, group) => sum + (group.TotalMembers || 0), 0)}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg p-6 shadow">
              <div className="flex items-center">
                <div className="p-2 bg-yellow-100 rounded-lg">
                  <UserCheck className="h-5 w-5 text-oe-warning" />
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-600">Active Enrollments</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {groups.reduce((sum, group) => sum + (group.ActiveEnrollments || 0), 0)}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg p-6 shadow">
              <div className="flex items-center">
                <div className="p-2 bg-purple-100 rounded-lg">
                  <DollarSign className="h-5 w-5 text-purple-600" />
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-600">Monthly Premium</p>
                  <p className="text-2xl font-bold text-gray-900">
                    ${groups.reduce((sum, group) => sum + (group.MonthlyPremium || 0), 0).toLocaleString()}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Actions and Filters */}
          <div className="bg-white shadow rounded-lg">
            <div className="p-6 border-b border-gray-200">
              <div className="flex justify-between items-center">
                <h2 className="text-lg font-medium text-gray-900">Groups</h2>
                <div className="flex space-x-3">
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                  >
                    <option value="">All Statuses</option>
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                  </select>
                  <button
                    onClick={() => setShowCreateModal(true)}
                    className="bg-oe-primary text-white px-4 py-2 rounded-md hover:bg-oe-dark flex items-center space-x-2"
                  >
                    <Plus className="h-4 w-4" />
                    <span>Create Group</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Group
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Contact
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Members
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Premium
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
                  {filteredGroups.map((group) => (
                    <tr key={group.GroupId} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/tenant-admin/groups/${group.GroupId}`)}>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="p-2 bg-oe-light rounded-lg mr-3">
                            <Building className="h-5 w-5 text-oe-primary" />
                          </div>
                          <div>
                            <div className="text-sm font-medium text-gray-900">
                              {group.Name}
                            </div>
                            <div className="text-sm text-gray-500">
                              {group.BusinessType && `${group.BusinessType} • `}{group.City}, {group.State}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{group.PrimaryContact}</div>
                        <div className="text-sm text-gray-500">{group.ContactEmail}</div>
                        {group.ContactTitle && (
                          <div className="text-xs text-gray-400">{group.ContactTitle}</div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <Users className="h-4 w-4 text-gray-400 mr-1" />
                          <span className="text-sm text-gray-900">{group.TotalMembers || 0}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <DollarSign className="h-4 w-4 text-gray-400 mr-1" />
                          <span className="text-sm text-gray-900">${(group.MonthlyPremium || 0).toLocaleString()}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                          group.Status === 'Active' 
                            ? 'bg-green-100 text-green-800' 
                            : 'bg-gray-100 text-gray-800'
                        }`}>
                          {group.Status}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center space-x-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleContributionSettings(group);
                            }}
                            className="text-indigo-600 hover:text-indigo-900 p-1 rounded"
                            title="Contribution Settings"
                          >
                            <Settings className="h-4 w-4" />
                          </button>
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              const fullGroupData = await fetchGroupDetails(group.GroupId);
                              if (fullGroupData) {
                                setSelectedGroup({...group, ...fullGroupData});
                                setShowEditModal(true);
                              } else {
                                showToast('Failed to load group details for editing', 'error');
                              }
                            }}
                            className="text-oe-primary hover:text-oe-dark p-1 rounded"
                            title="Edit Group"
                          >
                            <Edit className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* Create Group Modal - Pass getApiUrl function */}
      <GroupsAddGroup
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={handleCreateGroup}
        mode="create"
      />

      {/* Edit Group Modal - Pass getApiUrl function */}
      <GroupsAddGroup
        isOpen={showEditModal}
        onClose={() => setShowEditModal(false)}
        onSubmit={handleCreateGroup}
        editingGroup={selectedGroup}
        mode="edit"
      />

      {/* Contribution Settings Modal - NO getApiUrl prop */}
      <GroupsContributions
        isOpen={showContributionModal}
        onClose={() => setShowContributionModal(false)}
        selectedGroup={selectedGroup}
        products={products}
      />

      {/* Toast Notification */}
      <Snackbar
        open={toast.open}
        autoHideDuration={6000}
        onClose={handleCloseToast}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert 
          onClose={handleCloseToast} 
          severity={toast.severity} 
          sx={{ width: '100%' }}
          variant="filled"
        >
          {toast.message}
        </Alert>
      </Snackbar>
    </div>
  );
};

export default GroupsPage;