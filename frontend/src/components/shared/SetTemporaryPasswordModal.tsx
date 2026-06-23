/**
 * Set temporary password modal – admin sets a custom password for a user.
 * Role-aware: TenantAdmin (users in tenant) / SysAdmin (any user).
 */
import { KeyRound, Loader2, X } from 'lucide-react';
import React, { useState } from 'react';
import { toast } from 'react-hot-toast';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';

interface SetTemporaryPasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  displayName?: string;
  currentRole?: string;
  onSuccess: () => void;
}

const MIN_LENGTH = 8;

function getSetPasswordUrl(currentRole: string, userId: string): string {
  if (currentRole === 'SysAdmin') {
    return `/api/me/sysadmin/users/${userId}/set-temporary-password`;
  }
  return `/api/me/tenant-admin/users/${userId}/set-temporary-password`;
}

const SetTemporaryPasswordModal: React.FC<SetTemporaryPasswordModalProps> = ({
  isOpen,
  onClose,
  userId,
  displayName,
  currentRole,
  onSuccess,
}) => {
  const { user } = useAuth();
  const effectiveRole = currentRole || user?.currentRole || 'TenantAdmin';

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword.length < MIN_LENGTH) {
      setError(`Password must be at least ${MIN_LENGTH} characters`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setIsSubmitting(true);
    try {
      const url = getSetPasswordUrl(effectiveRole, userId);
      const res = await apiService.post<{ success: boolean; message?: string }>(url, { newPassword });
      if (res.success) {
        toast.success(res.message || 'Temporary password set successfully');
        onSuccess();
        handleClose();
      } else {
        setError(res.message || 'Failed to set password');
      }
    } catch (err: any) {
      const msg = err?.message || err?.response?.data?.message || 'Failed to set temporary password';
      setError(msg);
      toast.error(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
    onClose();
  };

  if (!isOpen) return null;

  const canSubmit = newPassword.length >= MIN_LENGTH && newPassword === confirmPassword && !isSubmitting;

  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        <div
          className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
          onClick={handleClose}
        />
        <div className="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full">
          <div className="bg-white px-6 py-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <KeyRound className="h-6 w-6 text-oe-primary mr-3" />
                <h3 className="text-lg font-medium text-gray-900">Set temporary password</h3>
              </div>
              <button
                type="button"
                onClick={handleClose}
                className="text-gray-400 hover:text-gray-500 transition-colors p-1 rounded-lg hover:bg-gray-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
          <form onSubmit={handleSubmit} className="px-6 py-4">
            {displayName && (
              <p className="text-sm text-gray-600 mb-4">
                Setting password for <span className="font-medium text-gray-900">{displayName}</span>
              </p>
            )}
            <div className="mb-4">
              <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700 mb-1">
                New password
              </label>
              <div className="relative">
                <input
                  id="newPassword"
                  type={showPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                    setError(null);
                  }}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder={`At least ${MIN_LENGTH} characters`}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700 text-sm"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
            <div className="mb-4">
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
                Confirm password
              </label>
              <input
                id="confirmPassword"
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  setError(null);
                }}
                className="block w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Confirm new password"
                autoComplete="new-password"
              />
            </div>
            {error && (
              <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="inline-flex items-center px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Setting...
                  </>
                ) : (
                  'Set password'
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default SetTemporaryPasswordModal;
