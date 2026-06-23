import {
    AlertCircle,
    ChevronLeft,
    ChevronRight,
    Clock,
    Edit,
    Filter,
    Mail,
    Plus,
    RefreshCw,
    Search,
    Trash2,
    Users,
    MoreVertical
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { useCreateUser, useCreateUserScoped, useDeleteUser, useDeleteUserScoped, useResendPasswordSetupLink, useResendPasswordSetupLinkScoped, useUpdateUser, useUpdateUserScoped, useUpdateUserStatus, useUpdateUserStatusScoped, useUserManagement, useUsers, useUsersScoped } from '../../hooks/useUserManagement';
import type { CreateUserRequest } from '../../services/user-management.service';
import { User, UserManagementService } from '../../services/user-management.service';
import { apiService } from '../../services/api.service';
import MultiSelectTenants from '../common/MultiSelectTenants';
import TenantUserAccountModal from '../tenant-admin/TenantUserAccountModal';

type UserManagementProps = {
  baseUrlOverride?: string;
  titleOverride?: string;
  descriptionOverride?: string;
  validRolesOverride?: string[];
  fixedRoles?: string[];
  linkBaseUrlOptions?: Array<{ label: string; value: string }>;
  defaultLinkBaseUrl?: string;
  hideRoleFilter?: boolean;
};

type UserManagementApiResponse = { success: boolean; message?: string; data?: { passwordSetupLink?: string } };

const UserManagement: React.FC<UserManagementProps> = ({
  baseUrlOverride,
  titleOverride,
  descriptionOverride,
  validRolesOverride,
  fixedRoles,
  linkBaseUrlOptions,
  defaultLinkBaseUrl,
  hideRoleFilter = false,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [selectedRole, setSelectedRole] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sortBy, setSortBy] = useState('FirstName');
  const [sortOrder, setSortOrder] = useState<'ASC' | 'DESC'>('ASC');
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const [selectedLinkBaseUrl, setSelectedLinkBaseUrl] = useState<string | undefined>(defaultLinkBaseUrl || linkBaseUrlOptions?.[0]?.value);
  const [openActionMenuUserId, setOpenActionMenuUserId] = useState<string | null>(null);
  const [accountModalUser, setAccountModalUser] = useState<User | null>(null);

  const queryClient = useQueryClient();
  const { user: authUser } = useAuth();
  const { validRoles, isSysAdmin, isTenantAdmin, isGroupAdmin } = useUserManagement();
  const isGroupAdminOnlyView = fixedRoles && fixedRoles.length === 1 && fixedRoles[0] === 'GroupAdmin';
  const effectiveFixedRoles = fixedRoles ?? (isTenantAdmin ? ['TenantAdmin'] : undefined);

  // Debounce search input to prevent excessive API calls and focus loss
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm);
      setCurrentPage(1); // Reset to first page when search changes
    }, 300); // 300ms debounce

    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Memoize filters to prevent unnecessary re-renders
  const filters = useMemo(() => ({
    search: debouncedSearchTerm,
    status: selectedStatus,
    roles: selectedRole,
    sortBy,
    sortOrder,
    page: currentPage,
    limit: pageSize
  }), [debouncedSearchTerm, selectedStatus, selectedRole, sortBy, sortOrder, currentPage, pageSize]);

  const scopedBaseUrl = baseUrlOverride || null;
  const useScoped = !!scopedBaseUrl;

  const { data: usersResponse, isLoading, error, refetch } = useScoped ? useUsersScoped(scopedBaseUrl, filters) : useUsers(filters);
  const createUserMutation = useScoped ? useCreateUserScoped(scopedBaseUrl) : useCreateUser();
  const updateUserMutation = useScoped ? useUpdateUserScoped(scopedBaseUrl) : useUpdateUser();
  const resendLinkMutation = useScoped ? useResendPasswordSetupLinkScoped(scopedBaseUrl) : useResendPasswordSetupLink();
  const updateStatusMutation = useScoped ? useUpdateUserStatusScoped(scopedBaseUrl) : useUpdateUserStatus();
  const deleteUserMutation = useScoped ? useDeleteUserScoped(scopedBaseUrl) : useDeleteUser();

  const users = usersResponse?.data || [];
  const pagination = usersResponse?.pagination;

  const handleCreateUser = async (userData: CreateUserRequest) => {
    try {
      // Client-side duplicate email check
      const emailExists = users.some(user => 
        user.email.toLowerCase() === userData.email.toLowerCase()
      );
      
      if (emailExists) {
        alert('A user with this email already exists in the current list. If you need to grant access for an existing account, try creating anyway from another session/view or refresh and check if they already have access.');
        return;
      }

      const response = await createUserMutation.mutateAsync({
        ...userData,
        linkBaseUrl: userData.linkBaseUrl || selectedLinkBaseUrl
      }) as UserManagementApiResponse;
      if (response.success) {
        setShowCreateModal(false);

        const setupLink = response.data?.passwordSetupLink;
        if (setupLink) {
          // Show success message with copy link option
          const copyLink = window.confirm(
            `User created successfully!\n\nPassword setup link generated:\n${setupLink}\n\nClick OK to copy the link to clipboard.`
          );
          
          if (copyLink) {
            await handleCopyLink(setupLink);
          }
        } else {
          alert(response.message || 'User access granted successfully. If they already had an account, they can sign in with their existing password.');
        }
        
        refetch();
      }
    } catch (error: any) {
      console.error('Failed to create user:', error);
      
      // Extract error message from various possible error structures
      let errorMessage = 'Failed to create user. Please try again.';
      
      // Check for timeout errors (both frontend and backend timeouts)
      const isTimeoutError = error?.code === 'NETWORK_ERROR' || 
                            error?.code === 'ECONNABORTED' || 
                            error?.message?.includes('timeout') ||
                            error?.message?.includes('Timeout');
      
      if (isTimeoutError) {
        errorMessage = 'The request timed out. The backend has a 30-second timeout limit. Creating TenantAdmin users may take longer due to additional setup required. Please contact the system administrator to increase the backend timeout or investigate the slow operation.';
      } else if (error?.response?.data?.error) {
        // Backend returned detailed error in 'error' field
        errorMessage = error.response.data.error;
      } else if (error?.response?.data?.message) {
        errorMessage = error.response.data.message;
      } else if (error?.data?.error) {
        errorMessage = error.data.error;
      } else if (error?.data?.message) {
        errorMessage = error.data.message;
      } else if (error?.message) {
        errorMessage = error.message;
      }
      
      alert(errorMessage);
    }
  };

  const handleEditUser = (user: User) => {
    setEditingUser(user);
    setShowEditModal(true);
  };

  const handleUpdateUser = async (userData: CreateUserRequest) => {
    if (!editingUser) return;
    
    try {
      const response = await updateUserMutation.mutateAsync({
        userId: editingUser.userId,
        userData
      }) as UserManagementApiResponse;
      
      if (response.success) {
        setShowEditModal(false);
        setEditingUser(null);
        alert('User updated successfully!');
        refetch();
      }
    } catch (error) {
      console.error('Failed to update user:', error);
      alert('Failed to update user. Please try again.');
    }
  };

  const handleResendLink = async (userId: string) => {
    try {
      const response = await resendLinkMutation.mutateAsync({ userId, linkBaseUrl: selectedLinkBaseUrl }) as UserManagementApiResponse;
      if (response.success) {
        // Show new link with copy option
        const copyLink = window.confirm(
          `New password setup link generated:\n${response.data.passwordSetupLink}\n\nClick OK to copy the link to clipboard.`
        );
        
        if (copyLink) {
          await handleCopyLink(response.data.passwordSetupLink);
        }
        
        refetch();
      }
    } catch (error) {
      console.error('Failed to resend link:', error);
      alert('Failed to resend password setup link. Please try again.');
    }
  };

  const handleResendSignInEmail = async (userId: string) => {
    try {
      const baseUrl = useScoped ? scopedBaseUrl : (isGroupAdmin ? '/api/me/group-admin/user-management' : null);
      if (!baseUrl) {
        alert('Resend sign-in email is not available in this context.');
        return;
      }

      const response = await apiService.post(`${baseUrl}/${userId}/resend-signin-email`, { linkBaseUrl: selectedLinkBaseUrl });
      if ((response as any).success) {
        alert('Sign-in email sent.');
        refetch();
      } else {
        alert((response as any).message || 'Failed to send sign-in email.');
      }
    } catch (error: any) {
      console.error('Failed to resend sign-in email:', error);
      alert(error?.response?.data?.message || error?.message || 'Failed to send sign-in email.');
    }
  };

  const handleUpdateStatus = async (userId: string, status: string) => {
    try {
      const response = await updateStatusMutation.mutateAsync({ userId, status }) as UserManagementApiResponse;
      if (response.success) {
        alert(`User status updated to ${status}`);
        refetch();
      }
    } catch (error) {
      console.error('Failed to update user status:', error);
      alert('Failed to update user status. Please try again.');
    }
  };

  /** Group-details scoped API: revokes Group Admin for this group only (does not delete oe.Users). */
  const handleRemoveGroupAdminScoped = async (userId: string): Promise<boolean> => {
    if (
      !window.confirm(
        'Remove group administrator access for this group? Their login account stays in the system. If they are still a member here, remove them from Members separately when you no longer need that record.'
      )
    ) {
      return false;
    }

    try {
      const response = await deleteUserMutation.mutateAsync(userId) as UserManagementApiResponse;
      if (response.success) {
        alert(response.message || 'Group administrator access removed.');
        await queryClient.invalidateQueries({ queryKey: ['users'] });
        await refetch();
        return true;
      }
      alert(response.message || 'Could not remove group administrator.');
    } catch (error: unknown) {
      console.error('Failed to remove group administrator:', error);
      let msg = 'Failed to remove group administrator. Please try again.';
      if (typeof error === 'object' && error !== null && 'response' in error) {
        const data = (error as { response?: { data?: { message?: string } } }).response?.data;
        if (data?.message) msg = data.message;
      }
      alert(msg);
    }
    return false;
  };

  const currentUserId = authUser?.userId || localStorage.getItem('userId') || '';

  const handleTenantAccountModalUpdated = async () => {
    const result = await refetch();
    const list = result.data?.data;
    setAccountModalUser((prev) => {
      if (!prev) return null;
      if (!Array.isArray(list)) return prev;
      const fresh = list.find((u: User) => u.userId === prev.userId);
      return fresh ?? null;
    });
  };

  const handleRemoveTenantAccess = async (u: User): Promise<boolean> => {
    if (currentUserId && u.userId === currentUserId) {
      return false;
    }
    const other = u.otherTenantAccessCount ?? 0;
    const retainNote =
      other > 0
        ? ` They will keep access to ${other} other tenant${other === 1 ? '' : 's'} (their primary tenant will switch).`
        : ' They only have this tenant; they will lose the tenant admin role here.';
    if (!window.confirm(`Remove this person’s access to this tenant? Their login account stays in the system.${retainNote}`)) {
      return false;
    }
    setOpenActionMenuUserId(null);
    try {
      const response = await deleteUserMutation.mutateAsync(u.userId) as UserManagementApiResponse & { message?: string };
      if (response.success) {
        await refetch();
        return true;
      }
    } catch (error: unknown) {
      console.error('Failed to remove tenant access:', error);
      const msg =
        typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message?: string }).message)
          : 'Failed to remove access. Please try again.';
      alert(msg);
    }
    return false;
  };

  const handleSort = (field: string) => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'ASC' ? 'DESC' : 'ASC');
    } else {
      setSortBy(field);
      setSortOrder('ASC');
    }
  };

  const handlePageSizeChange = (newPageSize: number) => {
    setPageSize(newPageSize);
    setCurrentPage(1); // Reset to first page when changing page size
  };

  const handleCopyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopiedLink(link);
      setTimeout(() => setCopiedLink(null), 2000);
    } catch (err) {
      console.error('Failed to copy link:', err);
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = link;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopiedLink(link);
      setTimeout(() => setCopiedLink(null), 2000);
    }
  };

  const getPageTitle = () => {
    if (titleOverride) return titleOverride;
    if (isSysAdmin) return 'System User Management';
    if (isTenantAdmin) return 'Tenant User Management';
    if (isGroupAdmin) return 'Group Admin Management';
    return 'User Management';
  };

  const getPageDescription = () => {
    if (descriptionOverride) return descriptionOverride;
    if (isSysAdmin) return 'Manage user accounts across all tenants and organizations';
    if (isTenantAdmin) return 'Manage tenant administrator accounts within your organization';
    if (isGroupAdmin) return 'Manage group administrator accounts for your group';
    return 'Manage user accounts';
  };

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center">
        <AlertCircle className="h-12 w-12 text-red-500 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">Error loading users</h3>
        <p className="text-gray-600 mb-4">Failed to load user data. Please try again.</p>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-oe-primary hover:bg-oe-primary-dark"
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{getPageTitle()}</h1>
          <p className="text-gray-600">{getPageDescription()}</p>
        </div>
        <div className="flex items-center gap-3">
          {Array.isArray(linkBaseUrlOptions) && linkBaseUrlOptions.length > 0 && (
            <select
              value={selectedLinkBaseUrl || ''}
              onChange={(e) => setSelectedLinkBaseUrl(e.target.value || undefined)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-oe-primary focus:border-oe-primary"
              aria-label="Password setup link domain"
              title="Password setup link domain"
            >
              {linkBaseUrlOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => setShowCreateModal(true)}
            className="btn-primary inline-flex items-center"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add User
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
        <div className={`grid grid-cols-1 md:grid-cols-${isTenantAdmin ? '3' : hideRoleFilter ? '3' : '4'} gap-4`}>
          <div className="relative">
            <Search className="h-5 w-5 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search users..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>

          {!hideRoleFilter && !isTenantAdmin && (
            <select
              value={selectedRole}
              onChange={(e) => setSelectedRole(e.target.value)}
              className="form-select focus:ring-oe-primary focus:border-oe-primary"
            >
              <option value="">All Roles</option>
              {(validRolesOverride || validRoles).map(role => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
          )}

          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="form-select focus:ring-oe-primary focus:border-oe-primary"
          >
            <option value="">All Statuses</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
            <option value="Suspended">Suspended</option>
            <option value="Pending">Pending</option>
          </select>

          <button
            onClick={() => refetch()}
            className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary"
          >
            <Filter className="h-4 w-4 mr-2" />
            Filter
          </button>
        </div>
      </div>

      {/* Users Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-gray-900">
              Users ({pagination?.total || 0})
            </h2>
            <div className="flex items-center space-x-2">
              <label className="text-sm text-gray-700">Show:</label>
              <select
                value={pageSize}
                onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                className="px-3 py-1 border border-gray-300 rounded-md text-sm focus:ring-oe-primary focus:border-oe-primary"
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </div>
          </div>
        </div>

        {/* Top Pagination */}
        {pagination && pagination.total > pageSize && users.length > 0 && (
          <div className="bg-white px-6 py-3 flex items-center justify-between border-b border-gray-200">
            <div className="flex-1 flex justify-between sm:hidden">
              <button
                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
                className="relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Previous page"
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Previous
              </button>
              <button
                onClick={() => setCurrentPage(Math.min(pagination.pages, currentPage + 1))}
                disabled={currentPage === pagination.pages}
                className="ml-3 relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Next page"
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </button>
            </div>
            <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
              <div>
                <p className="text-sm text-gray-700">
                  Showing <span className="font-medium">{((currentPage - 1) * pagination.limit) + 1}</span> to{' '}
                  <span className="font-medium">
                    {Math.min(currentPage * pagination.limit, pagination.total)}
                  </span>{' '}
                  of <span className="font-medium">{pagination.total}</span> results
                </p>
              </div>
              <div>
                <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px">
                  <button
                    onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                    disabled={currentPage === 1}
                    className="relative inline-flex items-center justify-center px-3 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-5 w-5 text-gray-600" />
                  </button>
                  {Array.from({ length: Math.min(5, pagination.pages) }, (_, i) => {
                    const page = i + 1;
                    return (
                      <button
                        key={page}
                        onClick={() => setCurrentPage(page)}
                        className={`relative inline-flex items-center px-4 py-2 border text-sm font-medium ${
                          currentPage === page
                            ? 'z-10 bg-blue-50 border-oe-primary text-oe-primary'
                            : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
                        }`}
                      >
                        {page}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setCurrentPage(Math.min(pagination.pages, currentPage + 1))}
                    disabled={currentPage === pagination.pages}
                    className="relative inline-flex items-center justify-center px-3 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-5 w-5 text-gray-600" />
                  </button>
                </nav>
              </div>
            </div>
          </div>
        )}

        {users.length === 0 ? (
          <div className="p-8 text-center">
            <Users className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No users found</h3>
            <p className="text-gray-600 mb-4">
              {searchTerm || selectedStatus || selectedRole
                ? 'Try adjusting your filters'
                : 'Get started by adding your first user'
              }
            </p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="btn-primary inline-flex items-center"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add User
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto overflow-y-visible min-h-[400px]">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th 
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('FirstName')}
                  >
                    User {sortBy === 'FirstName' && (sortOrder === 'ASC' ? '↑' : '↓')}
                  </th>
                  {!isGroupAdminOnlyView && (
                    <th 
                      className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                      onClick={() => handleSort('Roles')}
                    >
                      Role {sortBy === 'Roles' && (sortOrder === 'ASC' ? '↑' : '↓')}
                    </th>
                  )}
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Setup
                  </th>
                  <th 
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                    onClick={() => handleSort('LastLoginDate')}
                  >
                    Last Login {sortBy === 'LastLoginDate' && (sortOrder === 'ASC' ? '↑' : '↓')}
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {users.map((user) => (
                  <tr key={user.userId} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="flex-shrink-0 h-10 w-10">
                          <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
                            <span className="text-sm font-medium text-oe-primary">
                              {user.firstName.charAt(0)}{user.lastName.charAt(0)}
                            </span>
                          </div>
                        </div>
                        <div className="ml-4">
                          <div className="text-sm font-medium text-gray-900">
                            {user.firstName} {user.lastName}
                          </div>
                          <div className="text-sm text-gray-500 flex items-center">
                            <Mail className="h-4 w-4 mr-1" />
                            {user.email}
                          </div>
                        </div>
                      </div>
                    </td>
                    {!isGroupAdminOnlyView && (
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${UserManagementService.getRoleBadgeColor(user.roles[0])}`}>
                          {user.roles[0]}
                        </span>
                      </td>
                    )}
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center space-x-2">
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${UserManagementService.getAccountStatusBadgeColor(user.accountStatus)}`}>
                          {user.accountStatus === 'Active' ? 'Setup Complete' : 'Password setup sent'}
                        </span>
                        {(user.accountStatus === 'Pending' || user.accountStatus === 'Expired') && user.hasPasswordSetupLink && (
                          <div className="flex items-center text-xs text-gray-500">
                            <Clock className="h-3 w-3 mr-1" />
                            {UserManagementService.getTimeUntilExpiry(user.passwordSetupExpiry)}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {UserManagementService.formatDate(user.lastLoginDate)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      {isTenantAdmin && currentUserId && user.userId === currentUserId ? (
                        <span className="text-xs text-gray-400">—</span>
                      ) : isTenantAdmin && currentUserId && user.userId !== currentUserId ? (
                        <button
                          type="button"
                          onClick={() => setAccountModalUser(user)}
                          className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
                        >
                          <Edit className="h-4 w-4 mr-1.5" />
                          Edit
                        </button>
                      ) : (
                        <div className="relative inline-block text-left">
                          <button
                            type="button"
                            onClick={() => setOpenActionMenuUserId(openActionMenuUserId === user.userId ? null : user.userId)}
                            className="inline-flex items-center justify-center p-2 text-gray-400 hover:text-oe-primary hover:bg-blue-50 rounded-md transition-colors"
                            title="Actions"
                            aria-label="Actions"
                          >
                            <MoreVertical className="h-5 w-5" />
                          </button>

                          {openActionMenuUserId === user.userId && (
                            <div
                              className="absolute right-0 mt-2 w-56 origin-top-right rounded-md bg-white shadow-lg ring-1 ring-black ring-opacity-5 z-50"
                            >
                              <div className="py-1 flex flex-col">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenActionMenuUserId(null);
                                    handleEditUser(user);
                                  }}
                                  className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 whitespace-nowrap"
                                >
                                  Edit User
                                </button>
                                {(() => {
                                  const isPendingSetup = user.accountStatus === 'Pending' || user.accountStatus === 'Expired';
                                  return (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setOpenActionMenuUserId(null);
                                        if (isPendingSetup) {
                                          handleResendLink(user.userId);
                                        } else {
                                          handleResendSignInEmail(user.userId);
                                        }
                                      }}
                                      className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 whitespace-nowrap"
                                    >
                                      {isPendingSetup ? 'Resend Setup Email' : 'Resend Sign In Email'}
                                    </button>
                                  );
                                })()}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Bottom Pagination */}
        {pagination && pagination.total > pageSize && (
          <div className="bg-white px-6 py-3 flex items-center justify-between border-t border-gray-200">
            <div className="flex-1 flex justify-between sm:hidden">
              <button
                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
                className="relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Previous page"
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Previous
              </button>
              <button
                onClick={() => setCurrentPage(Math.min(pagination.pages, currentPage + 1))}
                disabled={currentPage === pagination.pages}
                className="ml-3 relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Next page"
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </button>
            </div>
            <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
              <div>
                <p className="text-sm text-gray-700">
                  Showing <span className="font-medium">{((currentPage - 1) * pagination.limit) + 1}</span> to{' '}
                  <span className="font-medium">
                    {Math.min(currentPage * pagination.limit, pagination.total)}
                  </span>{' '}
                  of <span className="font-medium">{pagination.total}</span> results
                </p>
              </div>
              <div>
                <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px">
                  <button
                    onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                    disabled={currentPage === 1}
                    className="relative inline-flex items-center justify-center px-3 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-5 w-5 text-gray-600" />
                  </button>
                  {Array.from({ length: Math.min(5, pagination.pages) }, (_, i) => {
                    const page = i + 1;
                    return (
                      <button
                        key={page}
                        onClick={() => setCurrentPage(page)}
                        className={`relative inline-flex items-center px-4 py-2 border text-sm font-medium ${
                          currentPage === page
                            ? 'z-10 bg-blue-50 border-oe-primary text-oe-primary'
                            : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
                        }`}
                      >
                        {page}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setCurrentPage(Math.min(pagination.pages, currentPage + 1))}
                    disabled={currentPage === pagination.pages}
                    className="relative inline-flex items-center justify-center px-3 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-5 w-5 text-gray-600" />
                  </button>
                </nav>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Create User Modal */}
      {showCreateModal && (
        <CreateUserModal
          onClose={() => setShowCreateModal(false)}
          onSubmit={handleCreateUser}
          validRoles={validRolesOverride || validRoles}
          fixedRoles={effectiveFixedRoles}
          linkBaseUrlOptions={linkBaseUrlOptions}
          defaultLinkBaseUrl={selectedLinkBaseUrl || defaultLinkBaseUrl}
          isLoading={createUserMutation.isPending}
          isSysAdmin={isSysAdmin}
        />
      )}

      {/* Edit User Modal */}
      {showEditModal && editingUser && (
        <EditUserModal
          user={editingUser}
          onClose={() => {
            setShowEditModal(false);
            setEditingUser(null);
          }}
          onSubmit={handleUpdateUser}
          validRoles={validRolesOverride || validRoles}
          isLoading={updateUserMutation.isPending}
          isSysAdmin={isSysAdmin}
          showRoleEditor={!isGroupAdminOnlyView && !isTenantAdmin}
          disableEmailEdit={isGroupAdminOnlyView}
          onRemoveGroupAdminAccess={
            useScoped && currentUserId && editingUser.userId !== currentUserId
              ? async () => {
                  const ok = await handleRemoveGroupAdminScoped(editingUser.userId);
                  if (ok) {
                    setShowEditModal(false);
                    setEditingUser(null);
                  }
                }
              : undefined
          }
          removeGroupAdminAccessLoading={deleteUserMutation.isPending}
        />
      )}

      {isTenantAdmin && accountModalUser ? (
        <TenantUserAccountModal
          isOpen
          accountHeading={useScoped ? 'Group administrator account' : 'Tenant admin account'}
          tenantUser={{
            userId: accountModalUser.userId,
            firstName: accountModalUser.firstName,
            lastName: accountModalUser.lastName,
            email: accountModalUser.email,
            status: accountModalUser.status,
            lastLoginDate: accountModalUser.lastLoginDate,
            otherTenantAccessCount: accountModalUser.otherTenantAccessCount
          }}
          onClose={() => setAccountModalUser(null)}
          onAccountUpdated={handleTenantAccountModalUpdated}
          onRemoveFromTenant={
            useScoped
              ? undefined
              : async () => {
                  const ok = await handleRemoveTenantAccess(accountModalUser);
                  if (ok) setAccountModalUser(null);
                }
          }
          removeFromTenantLoading={!useScoped && deleteUserMutation.isPending}
          onRemoveGroupAdminAccess={
            useScoped && currentUserId && accountModalUser.userId !== currentUserId
              ? async () => {
                  const ok = await handleRemoveGroupAdminScoped(accountModalUser.userId);
                  if (ok) setAccountModalUser(null);
                }
              : undefined
          }
          removeGroupAdminLoading={useScoped && deleteUserMutation.isPending}
        />
      ) : null}
    </div>
  );
};

// Create User Modal Component
interface CreateUserModalProps {
  onClose: () => void;
  onSubmit: (userData: CreateUserRequest) => void;
  validRoles: string[];
  fixedRoles?: string[];
  linkBaseUrlOptions?: Array<{ label: string; value: string }>;
  defaultLinkBaseUrl?: string;
  isLoading: boolean;
  isSysAdmin?: boolean;
}

const CreateUserModal: React.FC<CreateUserModalProps> = ({ onClose, onSubmit, validRoles, fixedRoles, linkBaseUrlOptions, defaultLinkBaseUrl, isLoading, isSysAdmin = false }) => {
  const { isTenantAdmin } = useUserManagement();
  const [formData, setFormData] = useState<CreateUserRequest>({
    firstName: '',
    lastName: '',
    email: '',
    phoneNumber: '',
    roles: fixedRoles && fixedRoles.length > 0 ? fixedRoles : [],
    additionalTenants: [],
    sendWelcomeEmail: true,
    linkBaseUrl: defaultLinkBaseUrl
  });
  const [emailError, setEmailError] = useState<string>('');
  const [touched, setTouched] = useState<{ [key: string]: boolean }>({});
  const [tenants, setTenants] = useState<Array<{ TenantId: string; Name: string }>>([]);
  const [loadingTenants, setLoadingTenants] = useState(false);
  const [systemRoles, setSystemRoles] = useState<Array<{ value: string; label: string; description: string }>>([]);
  const [loadingRoles, setLoadingRoles] = useState(false);

  // Fetch system roles from database (for both SysAdmin and TenantAdmin)
  useEffect(() => {
    if (isSysAdmin || isTenantAdmin) {
      setLoadingRoles(true);
      UserManagementService.getSystemRoles()
        .then(roles => {
          setSystemRoles(roles);
        })
        .catch(error => {
          console.error('Failed to fetch system roles:', error);
        })
        .finally(() => {
          setLoadingRoles(false);
        });
    }
  }, [isSysAdmin, isTenantAdmin]);

  // Fetch tenants for SysAdmin
  useEffect(() => {
    if (isSysAdmin) {
      setLoadingTenants(true);
      apiService.get<{ success: boolean; data?: Array<{ TenantId: string; Name: string }> }>('/api/tenants')
        .then(response => {
          if (response.success && response.data) {
            setTenants(response.data);
          }
        })
        .catch(error => {
          console.error('Failed to fetch tenants:', error);
        })
        .finally(() => {
          setLoadingTenants(false);
        });
    }
  }, [isSysAdmin]);

  // Email validation regex
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const validateEmail = (email: string): boolean => {
    if (!email.trim()) {
      setEmailError('Email is required');
      return false;
    }
    if (!emailRegex.test(email)) {
      setEmailError('Please enter a valid email address');
      return false;
    }
    setEmailError('');
    return true;
  };

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const email = e.target.value;
    setFormData(prev => ({ ...prev, email }));
    if (touched.email) {
      validateEmail(email);
    }
  };

  const handleBlur = (field: string) => {
    setTouched(prev => ({ ...prev, [field]: true }));
    if (field === 'email') {
      validateEmail(formData.email);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validate email before submission
    if (!validateEmail(formData.email)) {
      return;
    }
    
    // Validate at least one role is selected (unless fixed roles are provided)
    if ((!fixedRoles || fixedRoles.length === 0) && formData.roles.length === 0) {
      alert('Please select at least one role');
      return;
    }
    
    onSubmit(formData);
  };

  return (
    <div 
      className="fixed bg-black bg-opacity-50 flex items-center justify-center z-[9999]" 
      style={{ 
        position: 'fixed', 
        top: 0, 
        left: 0, 
        right: 0, 
        bottom: 0, 
        width: '100vw', 
        height: '100vh',
        margin: 0,
        padding: '1rem'
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="bg-white rounded-lg max-w-md w-full p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-medium text-gray-900 mb-4">
          {fixedRoles && fixedRoles.length === 1 && fixedRoles[0] === 'GroupAdmin' ? 'Add Group Admin User' : 'Create New User'}
        </h3>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                First Name
              </label>
              <input
                type="text"
                value={formData.firstName}
                onChange={(e) => setFormData(prev => ({ ...prev, firstName: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Last Name
              </label>
              <input
                type="text"
                value={formData.lastName}
                onChange={(e) => setFormData(prev => ({ ...prev, lastName: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              type="text"
              value={formData.email}
              onChange={handleEmailChange}
              onBlur={() => handleBlur('email')}
              className={`w-full px-3 py-2 border rounded-md focus:ring-oe-primary focus:border-oe-primary ${
                emailError ? 'border-red-300 focus:border-red-500 focus:ring-red-500' : 'border-gray-300'
              }`}
              required
            />
            {emailError && (
              <p className="mt-1 text-sm text-red-600">{emailError}</p>
            )}
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
            />
          </div>

          {/* Link domain selection (useful for localhost/dev) */}
          {Array.isArray(linkBaseUrlOptions) && linkBaseUrlOptions.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Password Setup Link Domain
              </label>
              <select
                value={formData.linkBaseUrl || ''}
                onChange={(e) => setFormData(prev => ({ ...prev, linkBaseUrl: e.target.value || undefined }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
              >
                {linkBaseUrlOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500">
                This controls which domain is used in the password setup link emailed to the user.
              </p>
            </div>
          )}

          {!fixedRoles || fixedRoles.length === 0 ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Roles <span className="text-gray-500 font-normal">(Select one or more)</span>
              </label>
              {loadingRoles ? (
                <div className="text-center py-4">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-oe-primary mx-auto"></div>
                  <p className="mt-2 text-xs text-gray-500">Loading roles...</p>
                </div>
              ) : (
                <>
                  <div className="space-y-2 border border-gray-300 rounded-md p-3 max-h-48 overflow-y-auto">
                    {(() => {
                      // Use systemRoles from database if available (for both SysAdmin and TenantAdmin)
                      // Fall back to validRoles only if systemRoles haven't loaded yet
                      let rolesToDisplay: string[] = [];
                      if ((isSysAdmin || isTenantAdmin) && systemRoles.length > 0) {
                        // Use roles from database
                        rolesToDisplay = systemRoles.map(r => r.value);
                      } else if (systemRoles.length === 0 && (isSysAdmin || isTenantAdmin)) {
                        // Still loading, show loading state (handled above)
                        return null;
                      } else {
                        // Fallback to validRoles for other roles (GroupAdmin, etc.)
                        rolesToDisplay = validRoles;
                      }
                      
                      // Define role descriptions for roles that might not have descriptions from backend
                      const defaultRoleDescriptions: Record<string, string> = {
                        'SysAdmin': 'System wide administrator',
                        'TenantAdmin': 'Tenant administrator - manages tenant settings and users',
                        'Agent': 'Agents are the sales people under the Tenant',
                        'Member': 'Some belong to Employers/Groups and some are',
                        'GroupAdmin': 'Group administrator - manages group settings and members'
                      };
                      
                      return rolesToDisplay.map(role => {
                        const roleInfo = isSysAdmin && systemRoles.length > 0 
                          ? systemRoles.find(r => r.value === role)
                          : null;
                        const description = roleInfo?.description || defaultRoleDescriptions[role] || '';
                        return (
                          <label key={role} className="flex items-start cursor-pointer hover:bg-gray-50 p-2 rounded">
                            <input
                              type="checkbox"
                              checked={formData.roles.includes(role)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setFormData(prev => ({ ...prev, roles: [...prev.roles, role] }));
                                } else {
                                  setFormData(prev => ({ ...prev, roles: prev.roles.filter(r => r !== role) }));
                                }
                              }}
                              className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded mt-0.5"
                            />
                            <div className="ml-2 flex-1">
                              <span className="text-sm font-medium text-gray-700">{role}</span>
                              {description && (
                                <p className="text-xs text-gray-500 mt-0.5">{description}</p>
                              )}
                            </div>
                          </label>
                        );
                      });
                    })()}
                  </div>
                  {formData.roles.length === 0 && (
                    <p className="mt-1 text-sm text-red-600">At least one role is required</p>
                  )}
                  {formData.roles.length > 0 && (
                    <p className="mt-2 text-sm text-gray-600">
                      Selected: {formData.roles.join(', ')}
                    </p>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
              Role:{' '}
              <span className="font-medium">
                {fixedRoles.length === 1 && fixedRoles[0] === 'TenantAdmin'
                  ? 'Tenant administrator'
                  : fixedRoles.join(', ')}
              </span>
            </div>
          )}

          {isSysAdmin && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Primary Tenant (Optional)
                </label>
                <select
                  value={formData.tenantId || ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, tenantId: e.target.value || undefined }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                  disabled={loadingTenants}
                >
                  <option value="">Select a tenant (optional)</option>
                  {tenants.map(tenant => (
                    <option key={tenant.TenantId} value={tenant.TenantId}>{tenant.Name}</option>
                  ))}
                </select>
                {loadingTenants && (
                  <p className="mt-1 text-xs text-gray-500">Loading tenants...</p>
                )}
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Additional Tenants
                </label>
                {loadingTenants ? (
                  <div className="text-center py-4">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-oe-primary mx-auto"></div>
                    <p className="mt-2 text-xs text-gray-500">Loading tenants...</p>
                  </div>
                ) : (
                  <MultiSelectTenants
                    tenants={tenants}
                    selectedTenantIds={formData.additionalTenants || []}
                    onChange={(selectedIds) => setFormData(prev => ({ ...prev, additionalTenants: selectedIds }))}
                    placeholder="Select additional tenants..."
                    excludeTenantId={formData.tenantId}
                  />
                )}
                <p className="mt-1 text-xs text-gray-500">
                  Select additional tenants this user can access as a TenantAdmin. The primary tenant is automatically excluded.
                </p>
              </div>
            </>
          )}

          <div className="flex items-center">
            <input
              type="checkbox"
              id="sendWelcomeEmail"
              checked={formData.sendWelcomeEmail}
              onChange={(e) => setFormData(prev => ({ ...prev, sendWelcomeEmail: e.target.checked }))}
              className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
            />
            <label htmlFor="sendWelcomeEmail" className="ml-2 block text-sm text-gray-700">
              Send welcome email with login instructions
            </label>
          </div>

          <div className="flex justify-end space-x-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!formData.firstName || !formData.lastName || !formData.email || !formData.roles[0] || isLoading || !!emailError}
              className="btn-primary"
            >
              {isLoading ? 'Creating...' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface EditUserModalProps {
  user: User;
  onClose: () => void;
  onSubmit: (userData: CreateUserRequest) => void;
  validRoles: string[];
  isLoading: boolean;
  isSysAdmin?: boolean;
  showRoleEditor?: boolean;
  disableEmailEdit?: boolean;
  /** Group Users tab (scoped): revoke Group Admin for this group only */
  onRemoveGroupAdminAccess?: () => void | Promise<void>;
  removeGroupAdminAccessLoading?: boolean;
}

const EditUserModal: React.FC<EditUserModalProps> = ({
  user,
  onClose,
  onSubmit,
  validRoles,
  isLoading,
  isSysAdmin = false,
  showRoleEditor = true,
  disableEmailEdit = false,
  onRemoveGroupAdminAccess,
  removeGroupAdminAccessLoading = false
}) => {
  const { isTenantAdmin } = useUserManagement();
  const [activeTab, setActiveTab] = useState<'basic' | 'roles' | 'tenant'>('basic');
  const [formData, setFormData] = useState<CreateUserRequest & { status?: string }>({
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phoneNumber: user.phoneNumber || '',
    roles: user.roles,
    tenantId: user.tenantId,
    status: user.status,
    sendWelcomeEmail: false
  });
  const [systemRoles, setSystemRoles] = useState<Array<{ value: string; label: string; description: string }>>([]);
  const [loadingRoles, setLoadingRoles] = useState(false);
  const [tenants, setTenants] = useState<Array<{ TenantId: string; Name: string }>>([]);
  const [loadingTenants, setLoadingTenants] = useState(false);

  // Fetch system roles from database (for both SysAdmin and TenantAdmin)
  useEffect(() => {
    if (isSysAdmin || isTenantAdmin) {
      setLoadingRoles(true);
      UserManagementService.getSystemRoles()
        .then(roles => {
          setSystemRoles(roles);
        })
        .catch(error => {
          console.error('Failed to fetch system roles:', error);
        })
        .finally(() => {
          setLoadingRoles(false);
        });
    }
  }, [isSysAdmin, isTenantAdmin]);


  // Fetch tenants for tenant assignment
  useEffect(() => {
    if (isSysAdmin) {
      setLoadingTenants(true);
      apiService.get<{ success: boolean; data?: Array<{ TenantId: string; Name: string }> }>('/api/tenants')
        .then(response => {
          if (response.success && response.data) {
            setTenants(response.data);
          }
        })
        .catch(error => {
          console.error('Failed to fetch tenants:', error);
        })
        .finally(() => {
          setLoadingTenants(false);
        });
    }
  }, [isSysAdmin]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validate at least one role is selected (roles are editable only when role editor is shown)
    if (showRoleEditor && formData.roles.length === 0) {
      alert('Please select at least one role');
      setActiveTab('roles');
      return;
    }
    
    // Submit user data first
    onSubmit(formData);
  };

  // Determine which roles to show (system roles from database for SysAdmin and TenantAdmin)
  let rolesToShow: string[] = [];
  if ((isSysAdmin || isTenantAdmin) && systemRoles.length > 0) {
    // Use roles from database
    rolesToShow = systemRoles.map(r => r.value);
  } else if (systemRoles.length === 0 && (isSysAdmin || isTenantAdmin)) {
    // Still loading, use empty array (will show loading state)
    rolesToShow = [];
  } else {
    // Fallback to validRoles for other roles (GroupAdmin, etc.)
    rolesToShow = validRoles;
  }
  
  // Define role descriptions for roles that might not have descriptions from backend
  const defaultRoleDescriptions: Record<string, string> = {
    'SysAdmin': 'System wide administrator',
    'TenantAdmin': 'Tenant administrator - manages tenant settings and users',
    'Agent': 'Agents are the sales people under the Tenant',
    'Member': 'Some belong to Employers/Groups and some are',
    'GroupAdmin': 'Group administrator - manages group settings and members'
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Edit User: {user.firstName} {user.lastName}</h3>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200 px-6">
          <nav className="flex space-x-8" aria-label="Tabs">
            <button
              type="button"
              onClick={() => setActiveTab('basic')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'basic'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Basic Info
            </button>
            {showRoleEditor && (
              <button
                type="button"
                onClick={() => setActiveTab('roles')}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'roles'
                    ? 'border-oe-primary text-oe-primary'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Roles
              </button>
            )}
            {isSysAdmin && showRoleEditor && (
              <button
                type="button"
                onClick={() => setActiveTab('tenant')}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'tenant'
                    ? 'border-oe-primary text-oe-primary'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Tenant Assignment
              </button>
            )}
          </nav>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-6">
            {/* Basic Info Tab */}
            {activeTab === 'basic' && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      First Name
                    </label>
                    <input
                      type="text"
                      value={formData.firstName}
                      onChange={(e) => setFormData(prev => ({ ...prev, firstName: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Last Name
                    </label>
                    <input
                      type="text"
                      value={formData.lastName}
                      onChange={(e) => setFormData(prev => ({ ...prev, lastName: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                      required
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email
                  </label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                    disabled={disableEmailEdit || isTenantAdmin}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-50 disabled:text-gray-500"
                    required
                  />
                  {(disableEmailEdit || isTenantAdmin) && (
                    <p className="mt-1 text-xs text-gray-500">
                      {isTenantAdmin
                        ? 'Email cannot be changed from tenant user management.'
                        : 'Email changes are disabled until we add a confirmation flow.'}
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Phone Number
                  </label>
                  <input
                    type="tel"
                    value={formData.phoneNumber}
                    onChange={(e) => setFormData(prev => ({ ...prev, phoneNumber: e.target.value }))}
                    disabled={isTenantAdmin}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-50 disabled:text-gray-500"
                  />
                  {isTenantAdmin && (
                    <p className="mt-1 text-xs text-gray-500">Phone cannot be changed from tenant user management.</p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Status
                  </label>
                  {isTenantAdmin ? (
                    <p className="px-3 py-2 border border-gray-200 rounded-md bg-gray-50 text-sm text-gray-800">
                      {formData.status || user.status}
                    </p>
                  ) : (
                    <select
                      value={formData.status || user.status}
                      onChange={(e) => setFormData(prev => ({ ...prev, status: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                    >
                      <option value="Active">Active</option>
                      <option value="Inactive">Inactive</option>
                    </select>
                  )}
                  {isTenantAdmin && (
                    <p className="mt-1 text-xs text-gray-500">Status cannot be changed here.</p>
                  )}
                </div>

                {showRoleEditor && (
                  <>
                    {/* Read-only roles summary (SysAdmin / group flows; tenant admin uses no role editor) */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Roles
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {(user.roles || []).map((r) => (
                          <span key={r} className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-800">
                            {r}
                          </span>
                        ))}
                      </div>
                      <p className="mt-1 text-xs text-gray-500">Roles are view-only here.</p>
                    </div>
                  </>
                )}
                {!showRoleEditor && isTenantAdmin && (
                  <p className="text-sm text-gray-600">
                    This user is a tenant administrator for your organization. Use the row menu → <strong>Remove user</strong> to revoke access.
                  </p>
                )}
              </div>
            )}

            {/* Roles Tab */}
            {showRoleEditor && activeTab === 'roles' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Current Roles
                  </label>
                  {loadingRoles ? (
                    <div className="text-center py-8">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto"></div>
                      <p className="mt-2 text-sm text-gray-500">Loading roles...</p>
                    </div>
                  ) : (
                    <>
                      {/* Current Roles List */}
                      {formData.roles.length === 0 ? (
                        <div className="border border-gray-300 rounded-md p-4 text-center">
                          <p className="text-sm text-gray-500">No roles assigned. Add a role below.</p>
                        </div>
                      ) : (
                        <div className="space-y-2 border border-gray-300 rounded-md p-3">
                          {formData.roles.map(role => {
                            const roleInfo = isSysAdmin && systemRoles.length > 0 
                              ? systemRoles.find(r => r.value === role)
                              : null;
                            const description = roleInfo?.description || defaultRoleDescriptions[role] || '';
                            return (
                              <div key={role} className="flex items-center justify-between bg-gray-50 hover:bg-gray-100 p-3 rounded-md">
                                <div className="flex-1">
                                  <span className="text-sm font-medium text-gray-900">{role}</span>
                                  {description && (
                                    <p className="text-xs text-gray-500 mt-0.5">{description}</p>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (formData.roles.length > 1) {
                                      setFormData(prev => ({ ...prev, roles: prev.roles.filter(r => r !== role) }));
                                    } else {
                                      alert('At least one role is required. Please add another role before removing this one.');
                                    }
                                  }}
                                  className="ml-3 text-red-600 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-500 rounded p-1"
                                  title="Remove role"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Add Role Dropdown */}
                      <div className="mt-4">
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Add Role
                        </label>
                        <select
                          value=""
                          onChange={(e) => {
                            const newRole = e.target.value;
                            if (newRole && !formData.roles.includes(newRole)) {
                              setFormData(prev => ({ ...prev, roles: [...prev.roles, newRole] }));
                            }
                            e.target.value = ''; // Reset dropdown
                          }}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                        >
                          <option value="">Select a role to add...</option>
                          {rolesToShow
                            .filter(role => !formData.roles.includes(role))
                            .map(role => {
                              const roleInfo = isSysAdmin && systemRoles.length > 0 
                                ? systemRoles.find(r => r.value === role)
                                : null;
                              const description = roleInfo?.description || defaultRoleDescriptions[role] || '';
                              return (
                                <option key={role} value={role}>
                                  {role}{description ? ` - ${description}` : ''}
                                </option>
                              );
                            })}
                        </select>
                        {rolesToShow.filter(role => !formData.roles.includes(role)).length === 0 && (
                          <p className="mt-1 text-xs text-gray-500">All available roles have been assigned</p>
                        )}
                      </div>

                      {formData.roles.length === 0 && (
                        <p className="mt-2 text-sm text-red-600">At least one role is required</p>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}


            {/* Tenant Assignment Tab */}
            {activeTab === 'tenant' && isSysAdmin && showRoleEditor && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Primary Tenant
                  </label>
                  {loadingTenants ? (
                    <div className="text-center py-4">
                      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-oe-primary mx-auto"></div>
                      <p className="mt-2 text-xs text-gray-500">Loading tenants...</p>
                    </div>
                  ) : (
                    <select
                      value={formData.tenantId || ''}
                      onChange={(e) => setFormData(prev => ({ ...prev, tenantId: e.target.value || undefined }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                    >
                      <option value="">Select a tenant</option>
                      {tenants.map(tenant => (
                        <option key={tenant.TenantId} value={tenant.TenantId}>{tenant.Name}</option>
                      ))}
                    </select>
                  )}
                  <p className="mt-1 text-xs text-gray-500">
                    TenantAdmin users must be assigned to a primary tenant to manage that tenant's data.
                  </p>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Additional Tenants
                  </label>
                  {loadingTenants ? (
                    <div className="text-center py-4">
                      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-oe-primary mx-auto"></div>
                      <p className="mt-2 text-xs text-gray-500">Loading tenants...</p>
                    </div>
                  ) : (
                    <MultiSelectTenants
                      tenants={tenants}
                      selectedTenantIds={formData.additionalTenants || []}
                      onChange={(selectedIds) => setFormData(prev => ({ ...prev, additionalTenants: selectedIds }))}
                      placeholder="Select additional tenants..."
                      excludeTenantId={formData.tenantId}
                    />
                  )}
                  <p className="mt-1 text-xs text-gray-500">
                    Select additional tenants this user can access as a TenantAdmin. The primary tenant is automatically excluded.
                  </p>
                </div>
              </div>
            )}
          </div>

          {onRemoveGroupAdminAccess ? (
            <div className="flex-shrink-0 px-6 py-3 border-t border-red-100 bg-red-50/60 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <p className="text-xs text-gray-600 max-w-xl">
                Removes group administrator access for this group only. Their login account and member records remain.
              </p>
              <button
                type="button"
                onClick={() => void onRemoveGroupAdminAccess()}
                disabled={removeGroupAdminAccessLoading}
                className="inline-flex justify-center items-center rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800 hover:bg-red-100 disabled:opacity-50 whitespace-nowrap"
              >
                {removeGroupAdminAccessLoading ? 'Removing…' : 'Remove group admin access'}
              </button>
            </div>
          ) : null}

          {/* Footer */}
          <div className="flex justify-end space-x-3 px-6 py-4 border-t border-gray-200 bg-gray-50 flex-shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="btn-primary"
            >
              {isLoading ? 'Updating...' : 'Update User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default UserManagement;
