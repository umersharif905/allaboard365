// frontend/src/components/vendor/VendorNetworksPanel.tsx
//
// Shared CRUD panel for vendor networks. Used by both:
//   - vendor self-serve view (VendorSettings → Networks tab) targeting /api/me/vendor/profile/networks
//   - admin/tenant-admin view (Vendors page → Networks tab) targeting /api/vendors/:vendorId/networks
//
// Each vendor can have multiple networks (titles only). Exactly one can be marked as the
// vendor's default. Default is used when an individual enrolls (no group), or when a
// group hasn't picked a network for that vendor yet. The panel is intentionally simple —
// list, add, rename, set-default, delete.
import { CheckCircle, Plus, Save, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';

export interface VendorNetwork {
  vendorNetworkId: string;
  vendorId: string;
  title: string;
  isDefault: boolean;
  isActive: boolean;
  createdDate?: string;
  modifiedDate?: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  message?: string;
}

interface Props {
  /** Mode controls which API path we hit. `self` is for the vendor-portal user. */
  mode: 'self' | 'admin';
  /** Required when mode === 'admin'. The Vendor whose networks we're managing. */
  vendorId?: string;
  /** Whether the current user can mutate (default true; pass false for read-only audiences). */
  canEdit?: boolean;
}

const VendorNetworksPanel: React.FC<Props> = ({ mode, vendorId, canEdit = true }) => {
  const [networks, setNetworks] = useState<VendorNetwork[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [draftTitleById, setDraftTitleById] = useState<Record<string, string>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newIsDefault, setNewIsDefault] = useState(false);
  const [creating, setCreating] = useState(false);

  const baseUrl = mode === 'self'
    ? '/api/me/vendor/profile/networks'
    : `/api/vendors/${vendorId}/networks`;

  const flash = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    window.setTimeout(() => setMessage(null), 3500);
  };

  const fetchNetworks = useCallback(async () => {
    if (mode === 'admin' && !vendorId) return;
    setLoading(true);
    try {
      const resp = await apiService.get<ApiEnvelope<VendorNetwork[]>>(baseUrl);
      if (resp?.success && Array.isArray(resp.data)) {
        setNetworks(resp.data);
        const drafts: Record<string, string> = {};
        for (const n of resp.data) drafts[n.vendorNetworkId] = n.title;
        setDraftTitleById(drafts);
      } else {
        setNetworks([]);
        flash('error', resp?.message || 'Failed to load networks');
      }
    } catch (err: any) {
      console.error('Failed to load vendor networks', err);
      flash('error', err?.message || 'Failed to load networks');
    } finally {
      setLoading(false);
    }
  }, [baseUrl, mode, vendorId]);

  useEffect(() => { fetchNetworks(); }, [fetchNetworks]);

  const handleCreate = async () => {
    const title = newTitle.trim();
    if (!title) {
      flash('error', 'Network title is required');
      return;
    }
    setCreating(true);
    try {
      const resp = await apiService.post<ApiEnvelope<VendorNetwork>>(baseUrl, {
        title,
        isDefault: newIsDefault
      });
      if (resp?.success) {
        flash('success', 'Network added');
        setShowAdd(false);
        setNewTitle('');
        setNewIsDefault(false);
        fetchNetworks();
      } else {
        flash('error', resp?.message || 'Failed to create network');
      }
    } catch (err: any) {
      flash('error', err?.message || 'Failed to create network');
    } finally {
      setCreating(false);
    }
  };

  const handleRename = async (network: VendorNetwork) => {
    const title = (draftTitleById[network.vendorNetworkId] || '').trim();
    if (!title || title === network.title) return;
    setSavingId(network.vendorNetworkId);
    try {
      const resp = await apiService.put<ApiEnvelope<VendorNetwork>>(`${baseUrl}/${network.vendorNetworkId}`, { title });
      if (resp?.success) {
        flash('success', 'Network renamed');
        fetchNetworks();
      } else {
        flash('error', resp?.message || 'Failed to rename');
      }
    } catch (err: any) {
      flash('error', err?.message || 'Failed to rename');
    } finally {
      setSavingId(null);
    }
  };

  const handleSetDefault = async (network: VendorNetwork) => {
    if (network.isDefault) return;
    setSavingId(network.vendorNetworkId);
    try {
      const resp = await apiService.put<ApiEnvelope<VendorNetwork>>(`${baseUrl}/${network.vendorNetworkId}`, { isDefault: true });
      if (resp?.success) {
        flash('success', 'Default updated');
        fetchNetworks();
      } else {
        flash('error', resp?.message || 'Failed to set default');
      }
    } catch (err: any) {
      flash('error', err?.message || 'Failed to set default');
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (network: VendorNetwork) => {
    if (!window.confirm(`Remove network "${network.title}"? Any group selections pointing to it will be cleared.`)) return;
    setDeletingId(network.vendorNetworkId);
    try {
      const resp = await apiService.delete<ApiEnvelope<unknown>>(`${baseUrl}/${network.vendorNetworkId}`);
      if (resp?.success) {
        flash('success', 'Network removed');
        fetchNetworks();
      } else {
        flash('error', resp?.message || 'Failed to delete');
      }
    } catch (err: any) {
      flash('error', err?.message || 'Failed to delete');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div>
      {message && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${
          message.type === 'success'
            ? 'bg-green-50 border border-green-200 text-green-800'
            : 'bg-red-50 border border-red-200 text-red-800'
        }`}>
          {message.text}
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Networks</h3>
            <p className="text-sm text-gray-500">
              Define network titles. ID card variations and group selections key off these.
            </p>
          </div>
          {canEdit && !showAdd && (
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-2 px-3 py-2 bg-oe-primary text-white text-sm rounded-lg hover:opacity-90"
            >
              <Plus className="h-4 w-4" />
              Add Network
            </button>
          )}
        </div>

        {showAdd && canEdit && (
          <div className="p-4 border-b border-gray-200 bg-gray-50">
            <div className="flex flex-col md:flex-row md:items-end gap-3">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. PPO, HMO, National Network"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
              </div>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 mb-1 md:mb-2">
                <input
                  type="checkbox"
                  checked={newIsDefault}
                  onChange={(e) => setNewIsDefault(e.target.checked)}
                />
                Set as default
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={creating}
                  onClick={handleCreate}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-oe-primary text-white text-sm rounded-lg hover:opacity-90 disabled:opacity-60"
                >
                  <Save className="h-4 w-4" />
                  {creating ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  disabled={creating}
                  onClick={() => { setShowAdd(false); setNewTitle(''); setNewIsDefault(false); }}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-white border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50 disabled:opacity-60"
                >
                  <X className="h-4 w-4" />
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="divide-y divide-gray-100">
          {loading ? (
            <div className="p-6 text-sm text-gray-500">Loading networks…</div>
          ) : networks.length === 0 ? (
            <div className="p-6 text-sm text-gray-500">
              No networks yet.{canEdit ? ' Click “Add Network” to create one.' : ''}
            </div>
          ) : (
            networks.map((n) => {
              const draft = draftTitleById[n.vendorNetworkId] ?? n.title;
              const renamed = draft.trim().length > 0 && draft.trim() !== n.title;
              const busy = savingId === n.vendorNetworkId || deletingId === n.vendorNetworkId;
              return (
                <div key={n.vendorNetworkId} className="p-4 flex flex-col md:flex-row md:items-center gap-3">
                  <div className="flex-1 flex items-center gap-3">
                    <input
                      type="text"
                      value={draft}
                      disabled={!canEdit || busy}
                      onChange={(e) => setDraftTitleById((prev) => ({ ...prev, [n.vendorNetworkId]: e.target.value }))}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-50"
                    />
                    {n.isDefault && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full bg-green-50 text-green-700 border border-green-200">
                        <CheckCircle className="h-3 w-3" />
                        Default
                      </span>
                    )}
                  </div>

                  {canEdit && (
                    <div className="flex flex-wrap gap-2">
                      {renamed && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleRename(n)}
                          className="inline-flex items-center gap-1 px-3 py-2 text-sm bg-oe-primary text-white rounded-lg hover:opacity-90 disabled:opacity-60"
                        >
                          <Save className="h-4 w-4" />
                          Save
                        </button>
                      )}
                      {!n.isDefault && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleSetDefault(n)}
                          className="inline-flex items-center gap-1 px-3 py-2 text-sm bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-60"
                        >
                          Set as default
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleDelete(n)}
                        className="inline-flex items-center gap-1 px-3 py-2 text-sm bg-white border border-red-300 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-60"
                      >
                        <Trash2 className="h-4 w-4" />
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export default VendorNetworksPanel;
