// Shared tenant admin user list + invite/remove — used by tenant-admin page and SysAdmin tenant modal.
import {
  Download,
  Filter,
  Plus,
  Search,
  Settings,
  Trash2,
  Users,
  X
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { TenantAdminService, type TenantAdminApiContext } from '../../services/tenant-admin/tenant-admin.service';
import type { CreateTenantUserRequest, TenantUser } from '../../types/tenant-admin/tenant-admin.types';
import TenantUserAccountModal from './TenantUserAccountModal';
import RemoveTenantAdminModal from './RemoveTenantAdminModal';

export interface TenantUserManagementPanelProps {
  /** When set (e.g. SysAdmin managing another tenant), API calls send `x-current-tenant-id`. */
  tenantId?: string;
  /** Optional line under the main actions (e.g. organization name). */
  subtitle?: string;
  /** Outer wrapper classes (default includes page padding). */
  className?: string;
}

const TenantUserManagementPanel: React.FC<TenantUserManagementPanelProps> = ({
  tenantId,
  subtitle,
  className = 'p-6 space-y-6'
}) => {
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string>('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [feedbackBanner, setFeedbackBanner] = useState<{
    kind: 'success' | 'info' | 'error';
    message: string;
  } | null>(null);
  /** Snapshot for account modal so it stays stable while the list reloads */
  const [accountModalUser, setAccountModalUser] = useState<TenantUser | null>(null);
  const [removeModalUser, setRemoveModalUser] = useState<TenantUser | null>(null);

  const apiContext: TenantAdminApiContext | undefined = tenantId ? { tenantId } : undefined;

  useEffect(() => {
    loadUsers();
  }, [searchTerm, selectedStatus, tenantId]);

  const loadUsers = async (): Promise<TenantUser[] | undefined> => {
    try {
      setLoading(true);
      const filters: Record<string, string> = {
        sortBy: 'firstName',
        sortOrder: 'asc',
        roleName: 'TenantAdmin'
      };

      if (searchTerm.trim()) {
        filters.search = searchTerm.trim();
      }

      if (selectedStatus.trim()) {
        filters.status = selectedStatus.trim();
      }

      const response = await TenantAdminService.getTenantUsers(filters, apiContext);

      if (response.success && response.data) {
        const list = response.data as TenantUser[];
        setUsers(list);
        return list;
      }
    } catch (error) {
      console.error('Failed to load users:', error);
    } finally {
      setLoading(false);
    }
    return undefined;
  };

  const handleTenantAccountUpdated = async () => {
    const list = await loadUsers();
    if (accountModalUser && list) {
      const fresh = list.find((u) => u.userId === accountModalUser.userId);
      if (fresh) setAccountModalUser(fresh);
      else setAccountModalUser(null);
    }
  };

  const handleCreateUser = async (userData: CreateTenantUserRequest) => {
    try {
      const response = await TenantAdminService.createTenantUser(userData, apiContext);

      if (response.success) {
        setShowCreateModal(false);
        const responseData = response.data as {
          isExistingUser?: boolean;
          requiresPasswordConfirmation?: boolean;
          crossTenantTenantAdminGranted?: boolean;
          alreadyHadTenantAdminAccessForOrg?: boolean;
        } | undefined;
        const apiMessage =
          typeof response.message === 'string' && response.message.trim()
            ? response.message
            : responseData?.alreadyHadTenantAdminAccessForOrg
              ? 'This user already has tenant admin access for this organization.'
              : responseData?.isExistingUser
                ? `Tenant admin access was updated for ${userData.email.trim()}.`
                : 'Tenant admin created.';

        const kind: 'success' | 'info' = responseData?.alreadyHadTenantAdminAccessForOrg ? 'info' : 'success';
        setFeedbackBanner({ kind, message: apiMessage });
        await loadUsers();
      } else {
        const errorData = response as {
          isAlreadyTenantAdmin?: boolean;
          isDifferentTenant?: boolean;
          message?: string;
        };
        let msg = errorData.message || 'Could not add tenant admin.';
        if (errorData?.isAlreadyTenantAdmin) {
          msg = 'This email already has tenant admin access for this organization.';
        } else if (errorData?.isDifferentTenant) {
          msg =
            'This email is tied to another organization in a way that blocks adding them here. Contact support if this should be allowed.';
        }
        setFeedbackBanner({ kind: 'error', message: msg });
      }
    } catch (error) {
      console.error('Failed to create tenant admin:', error);
      setFeedbackBanner({
        kind: 'error',
        message: 'Failed to add tenant admin. Please try again.'
      });
    }
  };

  const currentUserId = localStorage.getItem('userId') || '';

  const handleRemoveTenantAdmin = (user: TenantUser) => {
    if (currentUserId && user.userId === currentUserId) {
      return;
    }
    setRemoveModalUser(user);
  };

  const handleRemovedTenantAdmin = async (message: string) => {
    setFeedbackBanner({ kind: 'success', message });
    await loadUsers();
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'Active':
        return 'bg-green-100 text-green-800';
      case 'Inactive':
        return 'bg-yellow-100 text-yellow-800';
      case 'Suspended':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const openCreateModal = () => {
    setFeedbackBanner(null);
    setShowCreateModal(true);
  };

  const bannerStyles =
    feedbackBanner?.kind === 'error'
      ? 'bg-red-50 border border-red-200 text-red-800'
      : feedbackBanner?.kind === 'info'
        ? 'bg-blue-50 border border-blue-200 text-blue-800'
        : 'bg-green-50 border border-green-200 text-green-800';

  return (
    <div className={className}>
      {subtitle ? (
        <p className="text-sm text-gray-600 -mt-2 mb-2">{subtitle}</p>
      ) : null}

      {feedbackBanner ? (
        <div
          className={`rounded-lg p-4 flex gap-3 items-start ${bannerStyles}`}
          role={feedbackBanner.kind === 'error' ? 'alert' : 'status'}
        >
          <p className="text-sm flex-1">{feedbackBanner.message}</p>
          <button
            type="button"
            onClick={() => setFeedbackBanner(null)}
            className="shrink-0 p-1 rounded-md hover:bg-black/5 text-current"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={openCreateModal}
          className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add tenant admin
        </button>
      </div>

      <div className="bg-white p-4 rounded-lg border border-gray-200">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="relative">
            <Search className="h-5 w-5 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search by name or email..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">All statuses</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
            <option value="Suspended">Suspended</option>
          </select>

          <button
            type="button"
            onClick={loadUsers}
            className="inline-flex items-center justify-center px-4 py-2 border border-gray-300 rounded-lg text-gray-700 bg-white hover:bg-gray-50"
          >
            <Filter className="h-4 w-4 mr-2" />
            Refresh
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-gray-900">Tenant admins ({users.length})</h2>
            <button
              type="button"
              className="text-sm text-blue-600 hover:text-blue-800 font-medium inline-flex items-center"
            >
              <Download className="h-4 w-4 mr-1" />
              Export
            </button>
          </div>
        </div>

        {loading ? (
          <div className="p-8 flex items-center justify-center">
            <div className="animate-pulse h-8 w-8 rounded-full bg-gray-200" />
          </div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center">
            <Users className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No tenant admins found</h3>
            <p className="text-gray-600 mb-4">
              {searchTerm || selectedStatus ? 'Try adjusting filters.' : 'Add someone as a tenant admin by email.'}
            </p>
            <button
              type="button"
              onClick={openCreateModal}
              className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add tenant admin
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto overflow-y-visible pb-24">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Access</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Last login</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Account</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Remove access</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {users.map((user) => (
                  <tr key={user.userId} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="flex-shrink-0 h-10 w-10">
                          <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
                            <span className="text-sm font-medium text-blue-600">
                              {user.firstName.charAt(0)}
                              {user.lastName.charAt(0)}
                            </span>
                          </div>
                        </div>
                        <div className="ml-4">
                          <div className="text-sm font-medium text-gray-900">
                            {user.firstName} {user.lastName}
                          </div>
                          <div className="text-sm text-gray-500">{user.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-purple-100 text-purple-800">
                        Tenant admin
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadgeColor(user.status)}`}>
                        {user.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {user.lastLoginDate ? new Date(user.lastLoginDate).toLocaleDateString() : 'Never'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap align-middle">
                      <button
                        type="button"
                        onClick={() => setAccountModalUser(user)}
                        className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
                      >
                        <Settings className="h-4 w-4 mr-1.5" />
                        Manage
                      </button>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap align-middle">
                      {currentUserId && user.userId !== currentUserId ? (
                      <button
                        type="button"
                        onClick={() => handleRemoveTenantAdmin(user)}
                        className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-lg border border-red-200 text-red-700 bg-red-50 hover:bg-red-100"
                      >
                        <Trash2 className="h-4 w-4 mr-1.5" />
                        Remove
                      </button>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                      {(user.otherTenantAccessCount ?? 0) > 0 && (
                        <p className="mt-1 text-xs text-gray-500 max-w-[14rem]">
                          Also admin for {user.otherTenantAccessCount} other org
                          {user.otherTenantAccessCount === 1 ? '' : 's'}
                          {!user.isPrimaryForThisOrg ? ' (not primary here)' : ''}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreateModal && (
        <CreateUserModal
          onClose={() => setShowCreateModal(false)}
          onSubmit={handleCreateUser}
        />
      )}

      {accountModalUser ? (
        <TenantUserAccountModal
          isOpen
          tenantUser={accountModalUser}
          apiContext={apiContext}
          onClose={() => setAccountModalUser(null)}
          onAccountUpdated={handleTenantAccountUpdated}
        />
      ) : null}

      {removeModalUser ? (
        <RemoveTenantAdminModal
          user={removeModalUser}
          apiContext={apiContext}
          onClose={() => setRemoveModalUser(null)}
          onRemoved={handleRemovedTenantAdmin}
        />
      ) : null}
    </div>
  );
};

interface CreateUserModalProps {
  onClose: () => void;
  onSubmit: (userData: CreateTenantUserRequest) => void;
}

const CreateUserModal: React.FC<CreateUserModalProps> = ({ onClose, onSubmit }) => {
  const [formData, setFormData] = useState<CreateTenantUserRequest>({
    firstName: '',
    lastName: '',
    email: '',
    sendWelcomeEmail: true
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      ...formData,
      email: formData.email.trim()
    });
  };

  const canSubmit = Boolean(formData.email?.trim());

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black bg-opacity-50">
      <div className="bg-white rounded-lg border border-gray-200 max-w-md w-full p-6 shadow-xl">
        <h3 className="text-lg font-medium text-gray-900 mb-1">Add tenant admin</h3>
        <p className="text-sm text-gray-600 mb-4">
          Grants tenant admin for <strong className="font-medium text-gray-800">this organization only</strong> (the one you have selected). If that email already belongs to someone in Open Enroll, we do{' '}
          <strong className="font-medium text-gray-800">not</strong> create a duplicate login—we add tenant admin access to their existing account. An invitation email is optional; access is effective immediately.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="tu-email" className="block text-sm font-medium text-gray-700 mb-1">
              Email <span className="text-red-600">*</span>
            </label>
            <input
              id="tu-email"
              type="email"
              autoComplete="email"
              value={formData.email}
              onChange={(e) => setFormData((prev) => ({ ...prev, email: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              required
            />
          </div>

          <div>
            <label htmlFor="tu-first" className="block text-sm font-medium text-gray-700 mb-1">
              First name
            </label>
            <input
              id="tu-first"
              type="text"
              autoComplete="given-name"
              value={formData.firstName}
              onChange={(e) => setFormData((prev) => ({ ...prev, firstName: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              placeholder="Required for new users"
            />
          </div>

          <div>
            <label htmlFor="tu-last" className="block text-sm font-medium text-gray-700 mb-1">
              Last name
            </label>
            <input
              id="tu-last"
              type="text"
              autoComplete="family-name"
              value={formData.lastName}
              onChange={(e) => setFormData((prev) => ({ ...prev, lastName: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              placeholder="Required for new users"
            />
          </div>

          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              id="sendWelcomeEmail"
              checked={formData.sendWelcomeEmail}
              onChange={(e) => setFormData((prev) => ({ ...prev, sendWelcomeEmail: e.target.checked }))}
              className="h-4 w-4 mt-0.5 text-oe-primary focus:ring-primary-500 border-gray-300 rounded"
            />
            <label htmlFor="sendWelcomeEmail" className="text-sm text-gray-700">
              Send invitation email (optional — access is granted immediately)
            </label>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Add tenant admin
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default TenantUserManagementPanel;
