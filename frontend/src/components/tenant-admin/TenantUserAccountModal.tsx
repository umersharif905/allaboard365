/**
 * Account actions for a tenant admin user: password reset, change email, set temporary password.
 * Mirrors patterns from AgentManagementModal / MemberManagementModal (Authentication tab).
 */
import { AtSign, Building2, KeyRound, Loader2, Mail, Trash2, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import ChangeEmailModal from '../shared/ChangeEmailModal';
import SetTemporaryPasswordModal from '../shared/SetTemporaryPasswordModal';
import { useAuth } from '../../contexts/AuthContext';
import { authService } from '../../services/auth.service';
import {
  TenantAdminService,
  type TenantAdminApiContext
} from '../../services/tenant-admin/tenant-admin.service';
import type { PrimaryTenantChangePreview } from '../../types/tenant-admin/tenant-admin.types';
/** Minimal user shape for account actions (Tenant User list or User Management table). */
export type TenantUserAccountSubject = {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  status: string;
  lastLoginDate?: string;
  /** Shown in remove-access copy when provided */
  otherTenantAccessCount?: number;
};

export interface TenantUserAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  tenantUser: TenantUserAccountSubject;
  onAccountUpdated: () => void;
  /** SysAdmin managing another tenant — forwarded to tenant-admin API calls */
  apiContext?: TenantAdminApiContext;
  /** Modal title (default: tenant admin account). */
  accountHeading?: string;
  /** When set, show “Remove user” (revokes tenant admin for this org; account may remain) */
  onRemoveFromTenant?: () => void | Promise<void>;
  removeFromTenantLoading?: boolean;
  /** Group Users tab (scoped API): revoke Group Admin for this group only */
  onRemoveGroupAdminAccess?: () => void | Promise<void>;
  removeGroupAdminLoading?: boolean;
}

const TenantUserAccountModal: React.FC<TenantUserAccountModalProps> = ({
  isOpen,
  onClose,
  tenantUser,
  onAccountUpdated,
  apiContext,
  accountHeading = 'Tenant admin account',
  onRemoveFromTenant,
  removeFromTenantLoading = false,
  onRemoveGroupAdminAccess,
  removeGroupAdminLoading = false
}) => {
  const { user } = useAuth();
  const [changeEmailOpen, setChangeEmailOpen] = useState(false);
  const [setTempPasswordOpen, setSetTempPasswordOpen] = useState(false);
  const [sendResetLoading, setSendResetLoading] = useState(false);
  const [showResetSentModal, setShowResetSentModal] = useState(false);
  const [inlineMessage, setInlineMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [primaryPreview, setPrimaryPreview] = useState<PrimaryTenantChangePreview | null>(null);
  const [primaryPreviewLoading, setPrimaryPreviewLoading] = useState(false);
  const [selectedPrimaryTenantId, setSelectedPrimaryTenantId] = useState('');
  const [primarySaveLoading, setPrimarySaveLoading] = useState(false);
  const [primaryMessage, setPrimaryMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      setPrimaryPreviewLoading(true);
      setPrimaryMessage(null);
      const response = await TenantAdminService.getPrimaryTenantChangePreview(tenantUser.userId, apiContext);
      if (cancelled) return;
      if (response.success && response.data) {
        setPrimaryPreview(response.data);
        const current =
          response.data.accessibleTenants.find((t) => t.isPrimary)?.tenantId ||
          response.data.currentPrimaryTenantId;
        setSelectedPrimaryTenantId(current);
      } else {
        setPrimaryPreview(null);
      }
      setPrimaryPreviewLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, tenantUser.userId, apiContext?.tenantId]);

  if (!isOpen) return null;

  const displayName = [tenantUser.firstName, tenantUser.lastName].filter(Boolean).join(' ').trim() || tenantUser.email;
  const currentRole = user?.currentRole;

  const handleSendPasswordReset = async () => {
    if (!tenantUser.email) return;
    setInlineMessage(null);
    setSendResetLoading(true);
    try {
      await authService.requestPasswordReset(tenantUser.email);
      setShowResetSentModal(true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to send password reset email';
      setInlineMessage({ type: 'error', text: msg });
    } finally {
      setSendResetLoading(false);
    }
  };

  const handleSavePrimaryTenant = async () => {
    if (!selectedPrimaryTenantId || !primaryPreview?.canChangePrimary) return;
    setPrimarySaveLoading(true);
    setPrimaryMessage(null);
    const response = await TenantAdminService.changePrimaryTenant(
      tenantUser.userId,
      { newPrimaryTenantId: selectedPrimaryTenantId },
      apiContext
    );
    setPrimarySaveLoading(false);
    if (response.success) {
      setPrimaryMessage({
        type: 'success',
        text: response.message || 'Primary organization updated.'
      });
      onAccountUpdated();
      const refreshed = await TenantAdminService.getPrimaryTenantChangePreview(tenantUser.userId, apiContext);
      if (refreshed.success && refreshed.data) {
        setPrimaryPreview(refreshed.data);
        const current =
          refreshed.data.accessibleTenants.find((t) => t.isPrimary)?.tenantId ||
          refreshed.data.currentPrimaryTenantId;
        setSelectedPrimaryTenantId(current);
      }
    } else {
      setPrimaryMessage({
        type: 'error',
        text: response.message || 'Failed to change primary organization'
      });
    }
  };

  const primaryUnchanged =
    primaryPreview?.accessibleTenants.find((t) => t.isPrimary)?.tenantId === selectedPrimaryTenantId;

  return (
    <>
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black bg-opacity-50">
        <div className="bg-white rounded-lg border border-gray-200 shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
          <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-medium text-gray-900">{accountHeading}</h3>
              <p className="text-sm text-gray-600 mt-1">
                <span className="font-medium text-gray-900">{displayName}</span>
                {tenantUser.email ? (
                  <>
                    <span className="text-gray-400 mx-1">·</span>
                    <span className="text-gray-700">{tenantUser.email}</span>
                  </>
                ) : null}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Status: {tenantUser.status}
                {tenantUser.lastLoginDate
                  ? ` · Last login: ${new Date(tenantUser.lastLoginDate).toLocaleString()}`
                  : ' · Last login: never'}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="px-6 py-5 space-y-4">
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-2">Authentication</h4>
              <p className="text-xs text-gray-500 mb-3">
                Same tools as agent and member management: reset link, change sign-in email, or set a temporary password.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleSendPasswordReset}
                  disabled={sendResetLoading || !tenantUser.email}
                  className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {sendResetLoading ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-oe-primary inline-block mr-2" />
                      Sending...
                    </>
                  ) : (
                    <>
                      <Mail className="h-4 w-4 mr-2" />
                      Send password reset
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setInlineMessage(null);
                    setChangeEmailOpen(true);
                  }}
                  className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  <AtSign className="h-4 w-4 mr-2" />
                  Change email
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setInlineMessage(null);
                    setSetTempPasswordOpen(true);
                  }}
                  className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  <KeyRound className="h-4 w-4 mr-2" />
                  Set temporary password
                </button>
              </div>
              {inlineMessage && (
                <div
                  className={`mt-3 p-3 rounded-lg text-sm ${
                    inlineMessage.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
                  }`}
                >
                  {inlineMessage.text}
                </div>
              )}
            </div>

            {primaryPreviewLoading ? (
              <div className="pt-4 border-t border-gray-200 flex items-center text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Loading organization access…
              </div>
            ) : primaryPreview?.canChangePrimary ? (
              <div className="pt-4 border-t border-gray-200">
                <h4 className="text-sm font-medium text-gray-700 mb-1 flex items-center gap-2">
                  <Building2 className="h-4 w-4" />
                  Primary organization
                </h4>
                <p className="text-xs text-gray-500 mb-3">
                  This user can admin multiple organizations. Choose which one is their primary tenant — they keep access to all listed orgs.
                </p>
                <fieldset className="space-y-2 mb-3">
                  {primaryPreview.accessibleTenants.map((t) => (
                    <label
                      key={t.tenantId}
                      className="flex items-center gap-2 p-2 rounded-md border border-gray-200 hover:bg-gray-50 cursor-pointer"
                    >
                      <input
                        type="radio"
                        name="primaryTenant"
                        value={t.tenantId}
                        checked={selectedPrimaryTenantId === t.tenantId}
                        onChange={() => setSelectedPrimaryTenantId(t.tenantId)}
                        className="text-oe-primary focus:ring-oe-primary"
                      />
                      <span className="text-sm text-gray-900">
                        {t.name}
                        {t.isPrimary ? (
                          <span className="ml-2 text-xs font-medium text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded">
                            Current primary
                          </span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </fieldset>
                {primaryMessage ? (
                  <div
                    className={`mb-3 p-3 rounded-lg text-sm ${
                      primaryMessage.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
                    }`}
                  >
                    {primaryMessage.text}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => void handleSavePrimaryTenant()}
                  disabled={primarySaveLoading || primaryUnchanged || !selectedPrimaryTenantId}
                  className="inline-flex items-center rounded-lg bg-oe-primary px-3 py-2 text-sm font-medium text-white hover:bg-oe-dark disabled:opacity-50"
                >
                  {primarySaveLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Saving…
                    </>
                  ) : (
                    'Save primary organization'
                  )}
                </button>
              </div>
            ) : null}

            {onRemoveGroupAdminAccess ? (
              <div className="pt-4 border-t border-gray-200">
                <h4 className="text-sm font-medium text-gray-700 mb-1">Group administrator access</h4>
                <p className="text-xs text-gray-500 mb-3">
                  Remove this person&apos;s group admin role for this group only. Their login account and member records stay; remove them from Members separately if needed.
                </p>
                <button
                  type="button"
                  onClick={() => void onRemoveGroupAdminAccess()}
                  disabled={removeGroupAdminLoading}
                  className="inline-flex items-center rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                >
                  {removeGroupAdminLoading ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-red-200 border-t-red-700 inline-block mr-2" />
                      Removing...
                    </>
                  ) : (
                    <>
                      <Trash2 className="h-4 w-4 mr-2" />
                      Remove group admin access
                    </>
                  )}
                </button>
              </div>
            ) : null}

            {onRemoveFromTenant ? (
              <div className="pt-4 border-t border-gray-200">
                <h4 className="text-sm font-medium text-gray-700 mb-1">Access to this organization</h4>
                <p className="text-xs text-gray-500 mb-3">
                  Remove this person&apos;s tenant admin access here. Their login account remains; other organizations they can access are unchanged.
                </p>
                <button
                  type="button"
                  onClick={() => void onRemoveFromTenant()}
                  disabled={removeFromTenantLoading}
                  className="inline-flex items-center rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                >
                  {removeFromTenantLoading ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-red-200 border-t-red-700 inline-block mr-2" />
                      Removing...
                    </>
                  ) : (
                    <>
                      <Trash2 className="h-4 w-4 mr-2" />
                      Remove user
                    </>
                  )}
                </button>
              </div>
            ) : null}
          </div>

          <div className="px-6 py-4 border-t border-gray-200 flex justify-end">
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

      <ChangeEmailModal
        isOpen={changeEmailOpen}
        onClose={() => setChangeEmailOpen(false)}
        userId={tenantUser.userId}
        currentEmail={tenantUser.email ?? ''}
        displayName={displayName}
        currentRole={currentRole}
        onSuccess={() => {
          setChangeEmailOpen(false);
          onAccountUpdated();
        }}
      />
      <SetTemporaryPasswordModal
        isOpen={setTempPasswordOpen}
        onClose={() => setSetTempPasswordOpen(false)}
        userId={tenantUser.userId}
        displayName={displayName}
        currentRole={currentRole}
        onSuccess={() => {
          setSetTempPasswordOpen(false);
          onAccountUpdated();
        }}
      />

      {showResetSentModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[70] p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <div className="text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 mb-4">
                <Mail className="h-6 w-6 text-oe-success" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Password reset email sent</h3>
              <p className="text-sm text-gray-600 mb-2">
                A password reset link has been sent to this user&apos;s email address.
              </p>
              <p className="text-sm text-gray-500 mb-6">
                Remind them to check junk or spam if they don&apos;t see it in their inbox.
              </p>
              <button
                type="button"
                onClick={() => setShowResetSentModal(false)}
                className="w-full inline-flex justify-center rounded-lg bg-oe-primary px-4 py-2 text-sm font-medium text-white hover:bg-oe-dark"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default TenantUserAccountModal;
