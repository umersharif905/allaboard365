import { AlertTriangle, Loader2, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import {
  TenantAdminService,
  type TenantAdminApiContext
} from '../../services/tenant-admin/tenant-admin.service';
import type {
  RemoveTenantAdminRequest,
  TenantAdminRemovalMode,
  TenantAdminRemovalPreview,
  TenantUser
} from '../../types/tenant-admin/tenant-admin.types';

interface RemoveTenantAdminModalProps {
  user: TenantUser;
  apiContext?: TenantAdminApiContext;
  onClose: () => void;
  onRemoved: (message: string) => void;
}

const RemoveTenantAdminModal: React.FC<RemoveTenantAdminModalProps> = ({
  user,
  apiContext,
  onClose,
  onRemoved
}) => {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TenantAdminRemovalPreview | null>(null);
  const [newPrimaryTenantId, setNewPrimaryTenantId] = useState('');
  const [removalMode, setRemovalMode] = useState<TenantAdminRemovalMode>('removeRoleOnly');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const response = await TenantAdminService.getTenantAdminRemovalPreview(user.userId, apiContext);
      if (cancelled) return;
      if (response.success && response.data) {
        setPreview(response.data);
        if (response.data.candidatePrimaryTenants?.length) {
          setNewPrimaryTenantId(response.data.candidatePrimaryTenants[0].tenantId);
        }
        if (response.data.allowedRemovalModes?.length) {
          setRemovalMode(response.data.allowedRemovalModes[0]);
        }
      } else {
        setError(response.message || 'Could not load removal options');
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user.userId, apiContext?.tenantId]);

  const handleConfirm = async () => {
    if (!preview) return;

    if (preview.scenario === 'primary_with_others' && !newPrimaryTenantId) {
      setError('Select which organization should become their primary tenant.');
      return;
    }

    setSubmitting(true);
    setError(null);

    const payload: RemoveTenantAdminRequest = {};
    if (preview.scenario === 'primary_with_others') {
      payload.newPrimaryTenantId = newPrimaryTenantId;
    }
    if (preview.scenario === 'last_tenant') {
      payload.removalMode = removalMode;
    }

    const response = await TenantAdminService.deleteTenantUser(user.userId, payload, apiContext);
    setSubmitting(false);

    if (response.success) {
      onRemoved(response.message || 'Access removed.');
      onClose();
    } else {
      setError(response.message || 'Failed to remove access');
    }
  };

  const displayName = `${user.firstName} ${user.lastName}`.trim() || user.email;

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[70] p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">Remove tenant admin access</h3>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-gray-500">
              <Loader2 className="animate-spin h-5 w-5 mr-2" />
              Loading options…
            </div>
          ) : error && !preview ? (
            <div className="p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-800">{error}</div>
          ) : preview ? (
            <>
              <p className="text-sm text-gray-700">
                Remove <span className="font-medium">{displayName}</span> ({user.email}) as admin for{' '}
                <span className="font-medium">this organization</span>.
              </p>

              {preview.scenario === 'additional_only' && (
                <div className="rounded-lg bg-blue-50 border border-blue-100 p-3 text-sm text-blue-900">
                  They are not primary here. Their account stays active and they keep admin access to{' '}
                  {preview.otherTenantAccessCount} other organization
                  {preview.otherTenantAccessCount === 1 ? '' : 's'}.
                </div>
              )}

              {preview.scenario === 'primary_with_others' && (
                <div className="space-y-3">
                  <div className="rounded-lg bg-amber-50 border border-amber-100 p-3 text-sm text-amber-900 flex gap-2">
                    <AlertTriangle className="h-5 w-5 shrink-0" />
                    <span>
                      This is their primary organization. Choose a new primary tenant — they will keep
                      admin access to {preview.otherTenantAccessCount} other organization
                      {preview.otherTenantAccessCount === 1 ? '' : 's'}.
                    </span>
                  </div>
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium text-gray-900">New primary organization</legend>
                    {preview.candidatePrimaryTenants?.map((t) => (
                      <label
                        key={t.tenantId}
                        className="flex items-center gap-2 p-2 rounded-md border border-gray-200 hover:bg-gray-50 cursor-pointer"
                      >
                        <input
                          type="radio"
                          name="newPrimaryTenant"
                          value={t.tenantId}
                          checked={newPrimaryTenantId === t.tenantId}
                          onChange={() => setNewPrimaryTenantId(t.tenantId)}
                          className="text-oe-primary focus:ring-oe-primary"
                        />
                        <span className="text-sm text-gray-900">{t.name}</span>
                      </label>
                    ))}
                  </fieldset>
                </div>
              )}

              {preview.scenario === 'last_tenant' && (
                <div className="space-y-3">
                  {preview.hasOtherRoles ? (
                    <div className="rounded-lg bg-blue-50 border border-blue-100 p-3 text-sm text-blue-900">
                      This is their only admin organization, but they also have:{' '}
                      <span className="font-medium">{preview.otherRoles?.join(', ')}</span>. Only tenant
                      admin access will be removed — their account stays active for those roles.
                    </div>
                  ) : (
                    <div className="rounded-lg bg-amber-50 border border-amber-100 p-3 text-sm text-amber-900 flex gap-2">
                      <AlertTriangle className="h-5 w-5 shrink-0" />
                      <span>This is their only organization and they only have the tenant admin role.</span>
                    </div>
                  )}

                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium text-gray-900">What should happen?</legend>

                    <label className="flex items-start gap-2 p-2 rounded-md border border-gray-200 hover:bg-gray-50 cursor-pointer">
                      <input
                        type="radio"
                        name="removalMode"
                        value="removeRoleOnly"
                        checked={removalMode === 'removeRoleOnly'}
                        onChange={() => setRemovalMode('removeRoleOnly')}
                        className="mt-0.5 text-oe-primary focus:ring-oe-primary"
                      />
                      <span className="text-sm">
                        <span className="font-medium text-gray-900">Remove admin role only</span>
                        <span className="block text-gray-600">Account stays active in the system.</span>
                      </span>
                    </label>

                    {!preview.hasOtherRoles && (
                      <>
                        <label className="flex items-start gap-2 p-2 rounded-md border border-gray-200 hover:bg-gray-50 cursor-pointer">
                          <input
                            type="radio"
                            name="removalMode"
                            value="softDelete"
                            checked={removalMode === 'softDelete'}
                            onChange={() => setRemovalMode('softDelete')}
                            className="mt-0.5 text-oe-primary focus:ring-oe-primary"
                          />
                          <span className="text-sm">
                            <span className="font-medium text-gray-900">Deactivate account</span>
                            <span className="block text-gray-600">
                              Sets status to Inactive and removes tenant admin role.
                            </span>
                          </span>
                        </label>

                        <label className="flex items-start gap-2 p-2 rounded-md border border-red-200 hover:bg-red-50 cursor-pointer">
                          <input
                            type="radio"
                            name="removalMode"
                            value="permanentDelete"
                            checked={removalMode === 'permanentDelete'}
                            onChange={() => setRemovalMode('permanentDelete')}
                            className="mt-0.5 text-red-600 focus:ring-red-500"
                          />
                          <span className="text-sm">
                            <span className="font-medium text-red-800">Permanently delete account</span>
                            <span className="block text-red-700/80">
                              Removes the user record entirely. Cannot be undone.
                            </span>
                          </span>
                        </label>
                      </>
                    )}
                  </fieldset>
                </div>
              )}

              {error && (
                <div className="p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-800">
                  {error}
                </div>
              )}
            </>
          ) : null}
        </div>

        {!loading && preview && (
          <div className="flex justify-end gap-3 p-5 border-t border-gray-200">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={submitting}
              className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 text-sm font-medium"
            >
              {submitting ? (
                <>
                  <Loader2 className="animate-spin inline h-4 w-4 mr-2" />
                  Removing…
                </>
              ) : (
                'Confirm removal'
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default RemoveTenantAdminModal;
