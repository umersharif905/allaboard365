/**
 * Shared ChangeEmailModal - change a user's email with duplicate validation.
 * Used by SysAdmin, TenantAdmin, GroupAdmin, Agent, and AgencyOwner.
 */
import { CheckCircle, Loader2, Mail, X, XCircle } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useAuth } from '../../contexts/AuthContext';
import { UserEmailService } from '../../services/user-email.service';

interface ChangeEmailModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  currentEmail: string;
  displayName?: string;
  currentRole?: string;
  onSuccess: () => void;
}

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ChangeEmailModal: React.FC<ChangeEmailModalProps> = ({
  isOpen,
  onClose,
  userId,
  currentEmail,
  displayName,
  currentRole,
  onSuccess,
}) => {
  const { user } = useAuth();
  const effectiveRole = currentRole || user?.currentRole || 'SysAdmin';

  const [newEmail, setNewEmail] = useState(currentEmail);
  const [isChecking, setIsChecking] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailAvailable, setEmailAvailable] = useState<boolean | null>(null);

  const checkAvailability = useCallback(async () => {
    const trimmed = newEmail.trim().toLowerCase();
    if (!trimmed) {
      setError('Email is required');
      setEmailAvailable(null);
      return;
    }
    if (!emailRegex.test(trimmed)) {
      setError('Please enter a valid email address');
      setEmailAvailable(null);
      return;
    }
    if (trimmed === currentEmail.trim().toLowerCase()) {
      setError(null);
      setEmailAvailable(true);
      return;
    }

    setIsChecking(true);
    setError(null);
    setEmailAvailable(null);
    try {
      const response = await UserEmailService.checkEmailAvailable(trimmed, userId, effectiveRole);
      if (response.success && response.data?.available) {
        setEmailAvailable(true);
        setError(null);
      } else {
        setEmailAvailable(false);
        setError('This email is already in use by another user');
      }
    } catch (err: any) {
      setEmailAvailable(null);
      setError(err.message || 'Failed to check email availability');
    } finally {
      setIsChecking(false);
    }
  }, [newEmail, userId, currentEmail, effectiveRole]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmed = newEmail.trim().toLowerCase();
    if (!trimmed) {
      setError('Email is required');
      return;
    }
    if (!emailRegex.test(trimmed)) {
      setError('Please enter a valid email address');
      return;
    }
    if (trimmed === currentEmail.trim().toLowerCase()) {
      setError('Please enter a different email address');
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await UserEmailService.changeEmail(userId, trimmed, effectiveRole);
      if (response.success) {
        toast.success('Email updated successfully');
        onSuccess();
        onClose();
      } else {
        setError(response.message || 'Failed to update email');
      }
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to update email');
      toast.error(err.response?.data?.message || err.message || 'Failed to update email');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setNewEmail(currentEmail);
    setError(null);
    setEmailAvailable(null);
    onClose();
  };

  if (!isOpen) return null;

  const trimmed = newEmail.trim().toLowerCase();
  const isSameEmail = trimmed === currentEmail.trim().toLowerCase();
  const isValidFormat = trimmed && emailRegex.test(trimmed);
  const canSubmit = isValidFormat && !isSameEmail;

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
                <Mail className="h-6 w-6 text-oe-primary mr-3" />
                <h3 className="text-lg font-medium text-gray-900">Change Email</h3>
              </div>
              <button
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
                Updating email for <span className="font-medium text-gray-900">{displayName}</span>
              </p>
            )}

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">Current email</label>
              <p className="text-gray-600">{currentEmail}</p>
            </div>

            <div className="mb-4">
              <label htmlFor="newEmail" className="block text-sm font-medium text-gray-700 mb-1">
                New email
              </label>
              <div className="flex gap-2">
                <input
                  id="newEmail"
                  type="email"
                  value={newEmail}
                  onChange={(e) => {
                    setNewEmail(e.target.value);
                    setEmailAvailable(null);
                    setError(null);
                  }}
                  onBlur={() => {
                    if (trimmed && isValidFormat && !isSameEmail) checkAvailability();
                  }}
                  placeholder="Enter new email address"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  disabled={isSubmitting}
                />
                <button
                  type="button"
                  onClick={checkAvailability}
                  disabled={isChecking || !trimmed || !isValidFormat || isSameEmail || isSubmitting}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isChecking ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    'Check'
                  )}
                </button>
              </div>
              {emailAvailable === true && (
                <div className="mt-2 flex items-center text-green-600 text-sm">
                  <CheckCircle className="h-4 w-4 mr-1" />
                  Email is available
                </div>
              )}
              {emailAvailable === false && (
                <div className="mt-2 flex items-center text-red-600 text-sm">
                  <XCircle className="h-4 w-4 mr-1" />
                  Email is already in use
                </div>
              )}
            </div>

            {error && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit || isSubmitting}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Updating...
                  </>
                ) : (
                  'Update Email'
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default ChangeEmailModal;
