import { Eye, EyeOff, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { e123MigrationService } from '../../../services/e123Migration.service';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (instanceId: string, label: string) => void;
  mode?: 'create' | 'edit';
  instanceId?: string | null;
}

const MigrationInstanceModal: React.FC<Props> = ({
  isOpen,
  onClose,
  onSaved,
  mode = 'create',
  instanceId = null
}) => {
  const isEdit = mode === 'edit' && !!instanceId;
  const [label, setLabel] = useState('');
  const [e123CorpId, setE123CorpId] = useState('');
  const [e123Username, setE123Username] = useState('');
  const [e123Password, setE123Password] = useState('');
  const [orgBrokerId, setOrgBrokerId] = useState('');
  const [orgBrokerLabel, setOrgBrokerLabel] = useState('');
  const [enableTenantPortal, setEnableTenantPortal] = useState(false);
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [availableTenants, setAvailableTenants] = useState<Array<{ TenantId: string; Name: string }>>([]);
  const [assignedTenants, setAssignedTenants] = useState<Array<{ TenantId: string; Name?: string; TenantName?: string }>>([]);
  const [hasPassword, setHasPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const initialPasswordRef = useRef('');
  const [loading, setLoading] = useState(false);
  const [loadingInstance, setLoadingInstance] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);

    const load = async () => {
      setLoadingInstance(isEdit);
      try {
        if (isEdit && instanceId) {
          const [instanceRes, availableRes] = await Promise.all([
            e123MigrationService.getInstance(instanceId),
            e123MigrationService.listAvailableTenantsForInstance(instanceId)
          ]);
          if (!instanceRes.success || !instanceRes.data) {
            throw new Error(instanceRes.message || 'Failed to load migration instance');
          }
          const instance = instanceRes.data;
          setLabel(instance.label || '');
          setE123CorpId(instance.e123CorpId || '');
          setE123Username(instance.e123Username || '');
          const storedPassword = instance.e123Password || '';
          setE123Password(storedPassword);
          initialPasswordRef.current = storedPassword;
          setShowPassword(false);
          setHasPassword(!!instance.hasPassword || !!storedPassword);
          setOrgBrokerId(instance.orgBrokerId != null ? String(instance.orgBrokerId) : '');
          setOrgBrokerLabel(instance.orgBrokerLabel || '');
          setEnableTenantPortal(!!instance.enableTenantPortal);
          const currentTenants = instance.tenants || [];
          setAssignedTenants(currentTenants);
          setTenantIds(currentTenants.map((row) => row.TenantId));
          const available = availableRes.success ? (availableRes.data || []) : [];
          setAvailableTenants(available);
        } else {
          setLabel('');
          setE123CorpId('');
          setE123Username('');
          setE123Password('');
          initialPasswordRef.current = '';
          setShowPassword(false);
          setHasPassword(false);
          setOrgBrokerId('');
          setOrgBrokerLabel('');
          setEnableTenantPortal(false);
          setTenantIds([]);
          setAssignedTenants([]);
          const res = await e123MigrationService.listTenants();
          if (res.success) setAvailableTenants(res.data || []);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load migration instance');
      } finally {
        setLoadingInstance(false);
      }
    };

    void load();
  }, [isOpen, isEdit, instanceId]);

  const tenantOptions = useMemo(() => {
    const map = new Map<string, { TenantId: string; Name: string }>();
    for (const row of assignedTenants) {
      map.set(row.TenantId, {
        TenantId: row.TenantId,
        Name: row.Name || row.TenantName || row.TenantId
      });
    }
    for (const row of availableTenants) {
      if (!map.has(row.TenantId)) map.set(row.TenantId, row);
    }
    return [...map.values()].sort((a, b) => a.Name.localeCompare(b.Name));
  }, [assignedTenants, availableTenants]);

  if (!isOpen) return null;

  const toggleTenant = (tenantId: string) => {
    setTenantIds((prev) => (
      prev.includes(tenantId) ? prev.filter((id) => id !== tenantId) : [...prev, tenantId]
    ));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!label.trim()) {
      setError('Label is required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payload = {
        label: label.trim(),
        e123CorpId: e123CorpId.trim() || undefined,
        e123Username: e123Username.trim() || undefined,
        orgBrokerId: orgBrokerId.trim() ? Number(orgBrokerId) : null,
        orgBrokerLabel: orgBrokerLabel.trim() || undefined,
        enableTenantPortal,
        tenantIds
      };

      if (isEdit && instanceId) {
        const updatePayload: Record<string, unknown> = { ...payload };
        if (e123Password !== initialPasswordRef.current) {
          updatePayload.e123Password = e123Password;
        }
        const res = await e123MigrationService.updateInstance(instanceId, updatePayload);
        if (!res.success || !res.data?.instanceId) {
          throw new Error(res.message || 'Failed to update migration instance');
        }
        onSaved(res.data.instanceId, res.data.label);
      } else {
        const res = await e123MigrationService.createInstance({
          ...payload,
          e123Password: e123Password || undefined
        });
        if (!res.success || !res.data?.instanceId) {
          throw new Error(res.message || 'Failed to create migration instance');
        }
        onSaved(res.data.instanceId, res.data.label);
      }
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : `Failed to ${isEdit ? 'update' : 'create'} migration instance`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-xl rounded-lg bg-white shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {isEdit ? 'Edit migration' : 'New migration'}
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              {isEdit
                ? 'Update E123 credentials, tenant assignments, and portal access.'
                : 'Label this E123 org and enter login credentials.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>
          ) : null}

          {loadingInstance ? (
            <div className="py-8 text-center text-sm text-gray-500">Loading migration…</div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Label</label>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  placeholder="Sharewell Q1 2026"
                  autoFocus
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">E123 Corp ID</label>
                  <input value={e123CorpId} onChange={(e) => setE123CorpId(e.target.value)} className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">E123 username</label>
                  <input value={e123Username} onChange={(e) => setE123Username(e.target.value)} className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  E123 password
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={e123Password}
                    onChange={(e) => setE123Password(e.target.value)}
                    className="w-full rounded border border-gray-300 px-3 py-2 pr-10 text-sm"
                    autoComplete="off"
                    placeholder={
                      isEdit && hasPassword && !e123Password
                        ? 'Saved — leave blank to keep, or enter a new password'
                        : undefined
                    }
                  />
                  {(e123Password || (isEdit && hasPassword)) ? (
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-500 hover:text-gray-700"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      disabled={!e123Password}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  ) : null}
                </div>
                {isEdit && hasPassword && e123Password ? (
                  <p className="mt-1 text-xs text-gray-500">Stored password loaded. Use the eye icon to reveal it.</p>
                ) : null}
                {isEdit && hasPassword && !e123Password ? (
                  <p className="mt-1 text-xs text-green-700">
                    Password is saved on the server. Leave blank when saving to keep it, or enter a new value to replace it.
                  </p>
                ) : null}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Org broker ID (optional)</label>
                  <input value={orgBrokerId} onChange={(e) => setOrgBrokerId(e.target.value)} className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Org broker label (optional)</label>
                  <input value={orgBrokerLabel} onChange={(e) => setOrgBrokerLabel(e.target.value)} className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
                </div>
              </div>

              <label className="flex items-start gap-2 rounded-lg border border-gray-200 px-3 py-3 cursor-pointer hover:bg-gray-50">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={enableTenantPortal}
                  onChange={(e) => setEnableTenantPortal(e.target.checked)}
                />
                <span>
                  <span className="block text-sm font-medium text-gray-900">Enable Migration Tab in Tenant Portal</span>
                  <span className="block text-xs text-gray-600 mt-0.5">
                    When checked, assigned tenants see the E123 Migration tab and can run imports for their tenant only.
                  </span>
                </span>
              </label>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Tenants in this migration</label>
                <div className="max-h-40 overflow-y-auto rounded border border-gray-200 divide-y divide-gray-100">
                  {tenantOptions.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-gray-500">No tenants available.</div>
                  ) : tenantOptions.map((tenant) => (
                    <label key={tenant.TenantId} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={tenantIds.includes(tenant.TenantId)}
                        onChange={() => toggleTenant(tenant.TenantId)}
                      />
                      <span>{tenant.Name}</span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="flex justify-end gap-2 border-t border-gray-200 pt-4">
            <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50" disabled={loading}>
              Cancel
            </button>
            <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60" disabled={loading || loadingInstance}>
              {loading ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save changes' : 'Create migration')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default MigrationInstanceModal;
