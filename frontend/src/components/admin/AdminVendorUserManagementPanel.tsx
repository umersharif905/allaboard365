import { Filter, Mail, Plus, Search, Trash2, Users, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { AdminVendorUsersService, type AdminVendorUserRow } from '../../services/admin-vendor-users.service';

/** Shown in the list when filtering which roles count as "vendor portal" access */
const VENDOR_ROLE_NAMES = new Set(['VendorAdmin', 'VendorAgent']);

function userNeedsPasswordSetup(u: AdminVendorUserRow): boolean {
  const v = u.NeedsPasswordSetup as boolean | 0 | 1 | undefined;
  return v === true || v === 1;
}

export interface AdminVendorUserManagementPanelProps {
  vendorId: string;
  /** Shown in helper text */
  vendorName?: string;
  className?: string;
}

const AdminVendorUserManagementPanel: React.FC<AdminVendorUserManagementPanelProps> = ({
  vendorId,
  vendorName,
  className = 'p-3 md:p-4 space-y-4'
}) => {
  const [users, setUsers] = useState<AdminVendorUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string>('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [resendingUserId, setResendingUserId] = useState<string | null>(null);
  const [feedbackBanner, setFeedbackBanner] = useState<{
    kind: 'success' | 'info' | 'error';
    message: string;
  } | null>(null);

  const loadUsers = useCallback(async () => {
    try {
      setLoading(true);
      const response = await AdminVendorUsersService.listUsers(
        vendorId,
        selectedStatus || undefined
      );
      if (response.success && response.data) {
        setUsers(response.data);
      } else {
        setUsers([]);
      }
    } catch (e) {
      console.error('Failed to load vendor users:', e);
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, [vendorId, selectedStatus]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const vendorRolesOnly = (roles: string[] | undefined) =>
    (roles || []).filter((r) => VENDOR_ROLE_NAMES.has(r));

  const rowsFiltered = users.filter((u) => {
    if (!searchTerm.trim()) return true;
    const q = searchTerm.trim().toLowerCase();
    const name = `${u.FirstName || ''} ${u.LastName || ''}`.toLowerCase();
    const email = (u.Email || '').toLowerCase();
    return name.includes(q) || email.includes(q);
  });

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

  const currentUserId = localStorage.getItem('userId') || '';

  const handleResendSetup = async (u: AdminVendorUserRow) => {
    setResendingUserId(u.UserId);
    setFeedbackBanner(null);
    try {
      const res = await AdminVendorUsersService.resendSetupLink(vendorId, u.UserId, { sendWelcomeEmail: true });
      if (res.success) {
        setFeedbackBanner({
          kind: 'success',
          message: res.message || 'A new setup link was generated and a welcome email was queued when possible.',
        });
        const link = res.data?.passwordSetupLink;
        if (link) {
          const copy = window.confirm(`Password setup link (copy with OK):\n\n${link}`);
          if (copy) {
            try {
              await navigator.clipboard.writeText(link);
            } catch {
              /* ignore */
            }
          }
        }
        await loadUsers();
      } else {
        setFeedbackBanner({ kind: 'error', message: res.message || 'Could not resend the link.' });
      }
    } catch (err: unknown) {
      setFeedbackBanner({ kind: 'error', message: createModalErrorMessage(err) });
    } finally {
      setResendingUserId(null);
    }
  };

  const handleDeactivate = async (u: AdminVendorUserRow) => {
    if (currentUserId && String(u.UserId).toLowerCase() === String(currentUserId).toLowerCase()) {
      setFeedbackBanner({ kind: 'error', message: 'You cannot deactivate your own account.' });
      return;
    }
    if (
      !window.confirm(
        `Deactivate login for ${u.FirstName} ${u.LastName} (${u.Email})? They will no longer be able to sign in to the vendor portal until re-enabled.`
      )
    ) {
      return;
    }
    try {
      const res = await AdminVendorUsersService.deactivateUser(vendorId, u.UserId);
      if (res.success) {
        setFeedbackBanner({ kind: 'success', message: 'User deactivated.' });
        await loadUsers();
      } else {
        setFeedbackBanner({ kind: 'error', message: res.message || 'Deactivation failed.' });
      }
    } catch (err: unknown) {
      const m = err && typeof err === 'object' && 'message' in err ? String((err as { message?: string }).message) : 'Request failed';
      setFeedbackBanner({ kind: 'error', message: m });
    }
  };

  const openCreate = () => {
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
      <div className="mb-1">
        <p className="text-sm text-gray-600">
          People who can sign in to manage this vendor in the app (for example share requests{vendorName ? ` — ${vendorName}` : ''}).
        </p>
      </div>

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
          onClick={openCreate}
          className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add vendor user
        </button>
      </div>

      <div className="bg-white p-4 rounded-lg border border-gray-200">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="relative">
            <Search className="h-5 w-5 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search by name or email…"
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
          <h2 className="text-lg font-medium text-gray-900">Vendor users ({rowsFiltered.length})</h2>
        </div>

        {loading ? (
          <div className="p-8 flex items-center justify-center">
            <div className="animate-pulse h-8 w-8 rounded-full bg-gray-200" />
          </div>
        ) : rowsFiltered.length === 0 ? (
          <div className="p-8 text-center">
            <Users className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No users found</h3>
            <p className="text-gray-600 mb-4">
              {searchTerm || selectedStatus ? 'Try adjusting filters.' : 'Add someone who should access this vendor in the app.'}
            </p>
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add vendor user
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Access</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Last login</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {rowsFiltered.map((u) => (
                  <tr key={u.UserId} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">
                        {u.FirstName} {u.LastName}
                      </div>
                      <div className="text-sm text-gray-500">{u.Email}</div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1">
                        {vendorRolesOnly(u.roles).length === 0 ? (
                          <span className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                            No vendor portal role — add in user admin
                          </span>
                        ) : (
                          vendorRolesOnly(u.roles).map((r) => (
                            <span
                              key={r}
                              className="inline-flex px-2 py-0.5 text-xs font-medium rounded-full bg-indigo-50 text-indigo-800"
                            >
                              {r === 'VendorAdmin'
                                ? 'Vendor admin'
                                : r === 'VendorAgent'
                                  ? 'Vendor agent'
                                  : r}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadgeColor(u.Status)}`}>
                        {u.Status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {u.LastLoginDate ? new Date(u.LastLoginDate).toLocaleString() : 'Never'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {(() => {
                        const isActive = u.Status === 'Active';
                        const showResend = isActive && userNeedsPasswordSetup(u);
                        const showDeactivate =
                          isActive &&
                          (!currentUserId || String(u.UserId).toLowerCase() !== String(currentUserId).toLowerCase());
                        if (!showResend && !showDeactivate) {
                          return <span className="text-xs text-gray-400">—</span>;
                        }
                        return (
                          <div className="flex flex-col gap-1.5 items-start">
                            {showResend ? (
                              <button
                                type="button"
                                onClick={() => handleResendSetup(u)}
                                disabled={resendingUserId === u.UserId}
                                className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-lg border border-oe-primary/30 text-oe-primary bg-oe-primary/5 hover:bg-oe-primary/10 disabled:opacity-50"
                                title="Send a new password setup link and queue the welcome email again"
                              >
                                <Mail className="h-4 w-4 mr-1.5 shrink-0" />
                                {resendingUserId === u.UserId ? 'Sending…' : 'Resend link'}
                              </button>
                            ) : null}
                            {showDeactivate ? (
                              <button
                                type="button"
                                onClick={() => handleDeactivate(u)}
                                className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-lg border border-red-200 text-red-700 bg-red-50 hover:bg-red-100"
                              >
                                <Trash2 className="h-4 w-4 mr-1.5" />
                                Deactivate
                              </button>
                            ) : null}
                          </div>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreateModal ? (
        <CreateVendorUserModal
          vendorId={vendorId}
          onClose={() => setShowCreateModal(false)}
          onSuccess={async (response) => {
            setFeedbackBanner({ kind: 'success', message: response.message || 'Vendor user created.' });
            const link = response.data?.passwordSetupLink;
            if (link) {
              const copy = window.confirm(`Password setup link (copy with OK):\n\n${link}`);
              if (copy) {
                try {
                  await navigator.clipboard.writeText(link);
                } catch {
                  /* ignore */
                }
              }
            }
            await loadUsers();
          }}
        />
      ) : null}
    </div>
  );
};

function createModalErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const o = err as { message?: string; responseData?: { message?: string } };
    if (typeof o.message === 'string' && o.message.trim()) {
      return o.message;
    }
    if (o.responseData && typeof o.responseData === 'object' && o.responseData !== null) {
      const m = (o.responseData as { message?: string }).message;
      if (typeof m === 'string' && m.trim()) {
        return m;
      }
    }
  }
  return 'Failed to create user. Please try again.';
}

interface CreateModalProps {
  vendorId: string;
  onClose: () => void;
  onSuccess: (response: {
    message?: string;
    data?: { passwordSetupLink?: string };
  }) => void | Promise<void>;
}

const CreateVendorUserModal: React.FC<CreateModalProps> = ({ vendorId, onClose, onSuccess }) => {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [password, setPassword] = useState('');
  const [sendWelcomeEmail, setSendWelcomeEmail] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const clearError = () => setSubmitError(null);

  const canSubmit = Boolean(firstName.trim() && lastName.trim() && email.trim());

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black bg-opacity-50">
      <div
        className="bg-white rounded-lg border border-gray-200 max-w-lg w-full p-6 shadow-xl max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-vendor-user-title"
      >
        <h3 id="add-vendor-user-title" className="text-lg font-medium text-gray-900 mb-1">
          Add vendor user
        </h3>
        <p className="text-sm text-gray-600 mb-4">
          Creates a new login for the vendor portal (vendor admin access). If someone already uses this email in Open
          Enroll, you&apos;ll need a different email or use the main Users screen to change their access.
        </p>

        {submitError ? (
          <div
            className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
            role="alert"
            aria-live="assertive"
          >
            {submitError}
          </div>
        ) : null}

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!canSubmit) return;
            setSaving(true);
            setSubmitError(null);
            try {
              const response = await AdminVendorUsersService.createUser(vendorId, {
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                email: email.trim(),
                phoneNumber: phoneNumber.trim() || undefined,
                password: password.trim() || undefined,
                sendWelcomeEmail,
                roles: ['VendorAdmin'],
              });
              if (response && response.success) {
                await onSuccess(response);
                onClose();
              } else {
                setSubmitError(response?.message || 'Create failed.');
              }
            } catch (err) {
              setSubmitError(createModalErrorMessage(err));
            } finally {
              setSaving(false);
            }
          }}
          className="space-y-3"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">First name *</label>
              <input
                type="text"
                value={firstName}
                onChange={(e) => {
                  setFirstName(e.target.value);
                  clearError();
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Last name *</label>
              <input
                type="text"
                value={lastName}
                onChange={(e) => {
                  setLastName(e.target.value);
                  clearError();
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                required
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                clearError();
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Phone (optional)</label>
            <input
              type="tel"
              value={phoneNumber}
              onChange={(e) => {
                setPhoneNumber(e.target.value);
                clearError();
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            />
          </div>
          <p className="text-sm text-gray-600">
            <span className="font-medium text-gray-800">Access:</span> vendor admin (full access for this vendor in the
            app).
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Initial password (optional)</label>
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                clearError();
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              placeholder="Leave blank; user sets password via setup link"
            />
          </div>
          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              id="vwelcome"
              checked={sendWelcomeEmail}
              onChange={(e) => setSendWelcomeEmail(e.target.checked)}
              className="h-4 w-4 mt-0.5"
            />
            <label htmlFor="vwelcome" className="text-sm text-gray-700">
              Send welcome email with password setup link
            </label>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit || saving}
              className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AdminVendorUserManagementPanel;
