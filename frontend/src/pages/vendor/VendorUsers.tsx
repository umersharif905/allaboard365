// frontend/src/pages/vendor/VendorUsers.tsx
import { Eye, Mail, Phone, Plus, Search, Shield, User, Users, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiService } from '../../services/api.service';

interface VendorUserRow {
  UserId: string;
  FirstName: string | null;
  LastName: string | null;
  Email: string | null;
  PhoneNumber: string | null;
  Status: string;
  CreatedDate?: string | null;
  LastLoginDate?: string | null;
  roles?: string[];
}

interface CreateResponse {
  success: boolean;
  message?: string;
  data?: VendorUserRow & {
    passwordSetupLink?: string | null;
    passwordSetupRequired?: boolean;
    passwordSetupExpiry?: string | null;
    isExistingUser?: boolean;
    roleAlreadyAssigned?: boolean;
    welcomeEmail?: { success: boolean; messageId?: string; error?: string } | null;
  };
}

const VendorUsers: React.FC = () => {
  const [users, setUsers] = useState<VendorUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [detailsUser, setDetailsUser] = useState<VendorUserRow | null>(null);
  const [banner, setBanner] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  const loadUsers = useCallback(async () => {
    try {
      setLoading(true);
      const response = await apiService.get<{ success: boolean; data?: VendorUserRow[] }>(
        '/api/me/vendor/users'
      );
      if (response.success && Array.isArray(response.data)) {
        setUsers(response.data);
      } else {
        setUsers([]);
      }
    } catch (err) {
      console.error('Failed to load vendor users:', err);
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  // Show the full team — admins and agents. This page is VendorAdmin-only, so
  // listing who the admins are isn't exposed to agents.
  const teamMembers = useMemo(
    () => users.filter((u) => (u.roles || []).some((r) => r === 'VendorAgent' || r === 'VendorAdmin')),
    [users]
  );

  const filteredMembers = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return teamMembers;
    return teamMembers.filter((u) => {
      const name = `${u.FirstName || ''} ${u.LastName || ''}`.toLowerCase();
      const email = (u.Email || '').toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }, [teamMembers, searchTerm]);

  const isAdmin = (u: VendorUserRow) => (u.roles || []).includes('VendorAdmin');

  const bannerStyles =
    banner?.kind === 'error'
      ? 'bg-red-50 border border-red-200 text-red-800'
      : 'bg-green-50 border border-green-200 text-green-800';

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Users className="h-6 w-6 text-oe-primary" />
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Vendor Team</h1>
          <p className="text-sm text-gray-600">
            Manage the vendor agents on your team. Agents can sign in to the vendor portal to help with day-to-day work.
          </p>
        </div>
      </div>

      {banner ? (
        <div className={`rounded-lg p-4 flex gap-3 items-start ${bannerStyles}`} role="status">
          <p className="text-sm flex-1 whitespace-pre-line">{banner.message}</p>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="shrink-0 p-1 rounded-md hover:bg-black/5 text-current"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      <div className="bg-white p-4 rounded-lg border border-gray-200">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-center">
          <div className="relative">
            <Search className="h-5 w-5 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search vendor agents by name or email…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setBanner(null);
              setShowCreateModal(true);
            }}
            className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark"
          >
            <Plus className="h-4 w-4 mr-2" />
            New team member
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-medium text-gray-900">Vendor team ({filteredMembers.length})</h2>
        </div>

        {loading ? (
          <div className="p-8 flex items-center justify-center">
            <div className="animate-pulse h-8 w-8 rounded-full bg-gray-200" />
          </div>
        ) : filteredMembers.length === 0 ? (
          <div className="p-8 text-center">
            <Users className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No team members yet</h3>
            <p className="text-gray-600 mb-4">
              {searchTerm
                ? 'No team members match your search.'
                : 'Add a vendor agent so they can sign in and help manage your vendor account.'}
            </p>
            {!searchTerm ? (
              <button
                type="button"
                onClick={() => {
                  setBanner(null);
                  setShowCreateModal(true);
                }}
                className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark"
              >
                <Plus className="h-4 w-4 mr-2" />
                New team member
              </button>
            ) : null}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Name
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Role
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Email
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Phone
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredMembers.map((u) => (
                  <tr key={u.UserId} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {u.FirstName} {u.LastName}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${isAdmin(u) ? 'bg-oe-light text-oe-dark' : 'bg-gray-100 text-gray-600'}`}>
                        {isAdmin(u) ? 'Admin' : 'Agent'}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">{u.Email || '—'}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">{u.PhoneNumber || '—'}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <button
                        type="button"
                        onClick={() => setDetailsUser(u)}
                        className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
                      >
                        <Eye className="h-4 w-4 mr-1.5" />
                        See details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreateModal ? (
        <CreateVendorAgentModal
          onClose={() => setShowCreateModal(false)}
          onSuccess={async (response) => {
            const link = response.data?.passwordSetupLink;
            const emailSent = response.data?.welcomeEmail?.success === true;
            const baseMessage = response.message || 'Team member created successfully.';

            // If the welcome email went out, the agent already has the setup link in their inbox —
            // no need to expose it in the banner. Only show the link when email dispatch was skipped
            // or failed, so the VendorAdmin can hand it off manually.
            if (!emailSent && link) {
              setBanner({
                kind: 'success',
                message: `${baseMessage}\n\nPassword setup link:\n${link}`
              });
              try {
                await navigator.clipboard.writeText(link);
              } catch {
                /* ignore */
              }
            } else {
              setBanner({ kind: 'success', message: baseMessage });
            }
            await loadUsers();
          }}
        />
      ) : null}

      {detailsUser ? (
        <VendorAgentDetailsModal
          user={detailsUser}
          onClose={() => setDetailsUser(null)}
          onUpdated={loadUsers}
        />
      ) : null}
    </div>
  );
};

interface CreateModalProps {
  onClose: () => void;
  onSuccess: (response: CreateResponse) => void | Promise<void>;
}

const CreateVendorAgentModal: React.FC<CreateModalProps> = ({ onClose, onSuccess }) => {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [role, setRole] = useState<'VendorAgent' | 'VendorAdmin'>('VendorAgent');
  const [sendWelcomeEmail, setSendWelcomeEmail] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = Boolean(firstName.trim() && lastName.trim() && email.trim()) && !saving;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const response = await apiService.post<CreateResponse>('/api/me/vendor/users', {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        phoneNumber: phoneNumber.trim() || undefined,
        roles: [role],
        sendWelcomeEmail
      });
      if (response.success) {
        await onSuccess(response);
        onClose();
      } else {
        setError(response.message || 'Failed to create user.');
      }
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message?: string }).message)
          : 'Failed to create user.';
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black bg-opacity-50">
      <div
        className="bg-white rounded-lg border border-gray-200 max-w-lg w-full p-6 shadow-xl max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-vendor-agent-title"
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 id="new-vendor-agent-title" className="text-lg font-medium text-gray-900">
              New team member
            </h3>
            <p className="text-sm text-gray-600 mt-1">
              Add a Vendor Agent or Vendor Admin to your team. If they already have a login in this
              tenant, the role will be attached to their existing account so they can switch between
              portals without a new password.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md hover:bg-gray-100 text-gray-500"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error ? (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900" role="alert">
            {error}
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">First name *</label>
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Last name *</label>
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                required
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Phone (optional)</label>
            <input
              type="tel"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Role *</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'VendorAgent' | 'VendorAdmin')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            >
              <option value="VendorAgent">Vendor Agent — day-to-day back-office access</option>
              <option value="VendorAdmin">Vendor Admin — full access, can manage the team</option>
            </select>
          </div>

          <div className="flex items-start gap-2 pt-1">
            <input
              type="checkbox"
              id="vendor-agent-welcome"
              checked={sendWelcomeEmail}
              onChange={(e) => setSendWelcomeEmail(e.target.checked)}
              className="h-4 w-4 mt-0.5"
            />
            <label htmlFor="vendor-agent-welcome" className="text-sm text-gray-700">
              Send welcome email with password setup link
            </label>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
            >
              {saving ? 'Creating…' : role === 'VendorAdmin' ? 'Create vendor admin' : 'Create vendor agent'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface DetailsModalProps {
  user: VendorUserRow;
  onClose: () => void;
  onUpdated: () => void | Promise<void>;
}

const VendorAgentDetailsModal: React.FC<DetailsModalProps> = ({ user, onClose, onUpdated }) => {
  const [upgrading, setUpgrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roles = user.roles || [];
  const isAdmin = roles.includes('VendorAdmin');
  const isAgent = roles.includes('VendorAgent');

  const upgradeToAdmin = async () => {
    setUpgrading(true);
    setError(null);
    try {
      const response = await apiService.post<{ success: boolean; message?: string }>(
        `/api/me/vendor/users/${user.UserId}/roles`,
        { role: 'VendorAdmin' }
      );
      if (response.success) {
        await onUpdated();
        onClose();
      } else {
        setError(response.message || 'Failed to upgrade to Vendor Admin.');
      }
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message?: string }).message)
          : 'Failed to upgrade to Vendor Admin.';
      setError(msg);
    } finally {
      setUpgrading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black bg-opacity-50">
      <div
        className="bg-white rounded-lg border border-gray-200 max-w-md w-full p-6 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vendor-agent-details-title"
      >
        <div className="flex items-start justify-between mb-4">
          <h3 id="vendor-agent-details-title" className="text-lg font-medium text-gray-900">
            Team member details
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md hover:bg-gray-100 text-gray-500"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error ? (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900" role="alert">
            {error}
          </div>
        ) : null}

        <dl className="space-y-3">
          <div className="flex items-start gap-3">
            <User className="h-5 w-5 text-gray-400 mt-0.5" />
            <div>
              <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Name</dt>
              <dd className="text-sm text-gray-900">
                {user.FirstName} {user.LastName}
              </dd>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Shield className="h-5 w-5 text-gray-400 mt-0.5" />
            <div>
              <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Role</dt>
              <dd className="text-sm text-gray-900">{isAdmin ? 'Vendor Admin' : isAgent ? 'Vendor Agent' : '—'}</dd>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Mail className="h-5 w-5 text-gray-400 mt-0.5" />
            <div>
              <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Email</dt>
              <dd className="text-sm text-gray-900">{user.Email || '—'}</dd>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Phone className="h-5 w-5 text-gray-400 mt-0.5" />
            <div>
              <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Phone</dt>
              <dd className="text-sm text-gray-900">{user.PhoneNumber || '—'}</dd>
            </div>
          </div>
        </dl>

        <div className="flex justify-end gap-3 pt-4 mt-4 border-t border-gray-200">
          {isAgent && !isAdmin ? (
            <button
              type="button"
              onClick={upgradeToAdmin}
              disabled={upgrading}
              className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
            >
              {upgrading ? 'Upgrading…' : 'Upgrade to Vendor Admin'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default VendorUsers;
