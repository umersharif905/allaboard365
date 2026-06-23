import { X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { e123MigrationService } from '../../../services/e123Migration.service';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (instanceId: string, label: string) => void;
}

const NewMigrationInstanceModal: React.FC<Props> = ({ isOpen, onClose, onCreated }) => {
  const [label, setLabel] = useState('');
  const [e123CorpId, setE123CorpId] = useState('');
  const [e123Username, setE123Username] = useState('');
  const [e123Password, setE123Password] = useState('');
  const [orgBrokerId, setOrgBrokerId] = useState('');
  const [orgBrokerLabel, setOrgBrokerLabel] = useState('');
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [availableTenants, setAvailableTenants] = useState<Array<{ TenantId: string; Name: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    e123MigrationService.listTenants().then((res) => {
      if (res.success) setAvailableTenants(res.data || []);
    }).catch(() => setAvailableTenants([]));
  }, [isOpen]);

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
      const res = await e123MigrationService.createInstance({
        label: label.trim(),
        e123CorpId: e123CorpId.trim() || undefined,
        e123Username: e123Username.trim() || undefined,
        e123Password: e123Password || undefined,
        orgBrokerId: orgBrokerId.trim() ? Number(orgBrokerId) : null,
        orgBrokerLabel: orgBrokerLabel.trim() || undefined,
        tenantIds
      });
      if (!res.success || !res.data?.instanceId) {
        throw new Error(res.message || 'Failed to create migration instance');
      }
      onCreated(res.data.instanceId, res.data.label);
      setLabel('');
      setE123CorpId('');
      setE123Username('');
      setE123Password('');
      setOrgBrokerId('');
      setOrgBrokerLabel('');
      setTenantIds([]);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create migration instance');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-xl rounded-lg bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">New migration</h2>
            <p className="mt-1 text-sm text-gray-600">Label this E123 org and enter login credentials.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>
          ) : null}

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
            <label className="block text-sm font-medium text-gray-700 mb-1">E123 password</label>
            <input type="password" value={e123Password} onChange={(e) => setE123Password(e.target.value)} className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
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

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Tenants in this migration</label>
            <div className="max-h-40 overflow-y-auto rounded border border-gray-200 divide-y divide-gray-100">
              {availableTenants.length === 0 ? (
                <div className="px-3 py-2 text-sm text-gray-500">No unassigned tenants available.</div>
              ) : availableTenants.map((tenant) => (
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

          <div className="flex justify-end gap-2 border-t border-gray-200 pt-4">
            <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50" disabled={loading}>
              Cancel
            </button>
            <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60" disabled={loading}>
              {loading ? 'Creating…' : 'Create migration'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default NewMigrationInstanceModal;
