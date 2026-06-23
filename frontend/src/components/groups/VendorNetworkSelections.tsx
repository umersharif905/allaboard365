// frontend/src/components/groups/VendorNetworkSelections.tsx
//
// Inline panel rendered on a group's Products tab. Lists each vendor that
// (a) has at least one product currently selected for the group AND
// (b) has any networks defined. For each such vendor, surfaces a dropdown so
// the group admin can pick which network the group will use. The selection
// applies to all of that vendor's products on the group.
//
// Persisted via PUT /api/groups/:groupId/vendor-networks (caller decides
// when to flush — for create flows we hand the selections back via onChange
// so the parent can call PUT after the group is created; for edit flows the
// component can call PUT itself when `groupId` is provided + `autoSave`).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Pencil } from 'lucide-react';
import { apiService } from '../../services/api.service';

export interface VendorNetwork {
  vendorNetworkId: string;
  vendorId: string;
  title: string;
  isDefault: boolean;
  isActive: boolean;
}

/** A product reference with at least vendor info — most lists already have these fields. */
export interface VendorAwareProduct {
  ProductId?: string; productId?: string;
  VendorId?: string | null; vendorId?: string | null;
  VendorName?: string | null; vendorName?: string | null;
  Name?: string; name?: string; ProductName?: string;
}

/** Selection map keyed by VendorId. `null` means "use the vendor's default (no override)". */
export type VendorNetworkSelectionMap = Record<string, string | null>;

interface ApiEnvelope<T> { success: boolean; data?: T; message?: string; }

interface Props {
  /** Selected products for this group/household; we derive distinct vendors from these. */
  selectedProducts: VendorAwareProduct[];
  /** Current selections (controlled). */
  value: VendorNetworkSelectionMap;
  /** Called whenever the user changes a selection. */
  onChange: (next: VendorNetworkSelectionMap) => void;
  /** When set + autoSave true, persist via /api/groups/:groupId/vendor-networks. */
  groupId?: string;
  /** When set + autoSave true, persist via /api/households/:householdId/vendor-networks (used for individual members). Ignored if groupId is also set. */
  householdId?: string;
  autoSave?: boolean;
  /** Whether the current user can mutate selections. */
  canEdit?: boolean;
}

const VendorNetworkSelections: React.FC<Props> = ({
  selectedProducts,
  value,
  onChange,
  groupId,
  householdId,
  autoSave = false,
  canEdit = true
}) => {
  const persistUrl = groupId
    ? `/api/groups/${groupId}/vendor-networks`
    : householdId
      ? `/api/households/${householdId}/vendor-networks`
      : null;
  const scopeKind: 'group' | 'household' = groupId ? 'group' : 'household';
  // Cache networks per VendorId. Key present + [] = vendor has no networks; missing key = still loading.
  const [networksByVendor, setNetworksByVendor] = useState<Record<string, VendorNetwork[]>>({});
  const [savingMessage, setSavingMessage] = useState<string | null>(null);
  const fetchInFlight = useRef<Set<string>>(new Set());
  const networksByVendorRef = useRef(networksByVendor);
  networksByVendorRef.current = networksByVendor;

  // Distinct vendor list derived from currently selected products
  const distinctVendors = useMemo(() => {
    const map = new Map<string, { vendorId: string; vendorName: string }>();
    for (const p of selectedProducts || []) {
      const vid = (p.VendorId || p.vendorId || '').toString();
      if (!vid) continue;
      if (!map.has(vid)) {
        map.set(vid, {
          vendorId: vid,
          vendorName: (p.VendorName || p.vendorName || 'Vendor').toString()
        });
      }
    }
    return Array.from(map.values());
  }, [selectedProducts]);

  const vendorIdsKey = useMemo(
    () => distinctVendors.map((v) => v.vendorId).sort().join('|'),
    [distinctVendors]
  );

  // Drop cached networks for vendors no longer on selected products
  useEffect(() => {
    const activeIds = new Set(distinctVendors.map((v) => v.vendorId));
    setNetworksByVendor((prev) => {
      const stale = Object.keys(prev).filter((id) => !activeIds.has(id));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [vendorIdsKey, distinctVendors]);

  // Fetch networks for each distinct vendor once (do not tie deps to networksByVendor — that re-ran
  // the effect on every fetch and left loading stuck when cleanup set cancelled=true).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const v of distinctVendors) {
        const vid = v.vendorId;
        if (Object.prototype.hasOwnProperty.call(networksByVendorRef.current, vid)) continue;
        if (fetchInFlight.current.has(vid)) continue;
        fetchInFlight.current.add(vid);
        try {
          const resp = await apiService.get<ApiEnvelope<VendorNetwork[]>>(`/api/vendors/${vid}/networks`);
          const arr = resp?.success && Array.isArray(resp.data) ? resp.data : [];
          if (cancelled) return;
          setNetworksByVendor((prev) => (Object.prototype.hasOwnProperty.call(prev, vid) ? prev : { ...prev, [vid]: arr }));
        } catch (err) {
          console.warn(`Failed to load networks for vendor ${vid}`, err);
          if (cancelled) return;
          setNetworksByVendor((prev) => (Object.prototype.hasOwnProperty.call(prev, vid) ? prev : { ...prev, [vid]: [] }));
        } finally {
          fetchInFlight.current.delete(vid);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [vendorIdsKey, distinctVendors]);

  // Default-fill: if a vendor has networks and no selection yet, prefill with that vendor's default network
  useEffect(() => {
    let mutated = false;
    const next: VendorNetworkSelectionMap = { ...value };
    for (const v of distinctVendors) {
      const list = networksByVendor[v.vendorId];
      if (!list) continue;
      if (next[v.vendorId] !== undefined) continue;
      const def = list.find((n) => n.isDefault && n.isActive !== false);
      if (def) {
        next[v.vendorId] = def.vendorNetworkId;
        mutated = true;
      }
    }
    if (mutated) onChange(next);
    // We intentionally only react when networks fetch completes for a vendor; value changes
    // shouldn't retrigger this prefill loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [networksByVendor, distinctVendors]);

  const persistIfNeeded = useCallback(async (next: VendorNetworkSelectionMap) => {
    if (!autoSave || !persistUrl) return;
    try {
      setSavingMessage('Saving…');
      const resp = await apiService.put<ApiEnvelope<unknown>>(persistUrl, { selections: next });
      if (resp?.success) {
        setSavingMessage('Saved');
        window.setTimeout(() => setSavingMessage(null), 1500);
      } else {
        setSavingMessage(resp?.message || 'Save failed');
      }
    } catch (err: any) {
      setSavingMessage(err?.message || 'Save failed');
    }
  }, [autoSave, persistUrl]);

  const handleSelect = (vendorId: string, networkId: string | null) => {
    const next = { ...value, [vendorId]: networkId };
    onChange(next);
    persistIfNeeded(next);
  };

  // ---- Edit-network modal state ----
  const [editingVendorId, setEditingVendorId] = useState<string | null>(null);
  const [pendingNetworkId, setPendingNetworkId] = useState<string>('');

  const openEditModal = (vendorId: string) => {
    setEditingVendorId(vendorId);
    setPendingNetworkId(value[vendorId] ?? '');
  };

  const closeEditModal = () => {
    setEditingVendorId(null);
    setPendingNetworkId('');
  };

  const confirmEdit = () => {
    if (!editingVendorId) return;
    handleSelect(editingVendorId, pendingNetworkId || null);
    closeEditModal();
  };

  // Only show vendors that have ≥1 active network defined
  const vendorsWithNetworks = distinctVendors.filter((v) => (networksByVendor[v.vendorId] || []).some((n) => n.isActive !== false));

  if (distinctVendors.length === 0) return null;

  const allVendorsResolved = distinctVendors.every((v) =>
    Object.prototype.hasOwnProperty.call(networksByVendor, v.vendorId)
  );

  // No vendors define networks — hide section (not applicable for this group/household)
  if (vendorsWithNetworks.length === 0) {
    return allVendorsResolved ? null : (
      <div className="mt-6 text-sm text-gray-500">Checking vendor networks…</div>
    );
  }

  return (
    <div className="mt-6 bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h4 className="text-md font-semibold text-gray-900">Vendor Networks</h4>
          <p className="text-sm text-gray-500">
            {scopeKind === 'household'
              ? 'Pick the network this household should use per vendor. All household members will see the matching ID card variation. Choose "Use default" to fall back to the vendor\'s default.'
              : 'Pick the network this group should use per vendor. Members under this group will see the matching ID card variation. Choose "Use default" to fall back to the vendor\'s default.'}
          </p>
        </div>
        {savingMessage && (
          <span className="text-xs text-gray-500">{savingMessage}</span>
        )}
      </div>

      <div className="space-y-3">
        {vendorsWithNetworks.map((v) => {
          const list = networksByVendor[v.vendorId] || [];
          const def = list.find((n) => n.isDefault);
          const selectedId = value[v.vendorId] ?? null;
          const selectedNetwork = selectedId ? list.find((n) => n.vendorNetworkId === selectedId) : null;
          const displayLabel = selectedNetwork
            ? `${selectedNetwork.title}${selectedNetwork.isDefault ? ' (default)' : ''}`
            : (def ? `Use vendor default — ${def.title}` : 'Use vendor default');
          return (
            <div key={v.vendorId} className="flex flex-col md:flex-row md:items-center gap-2 p-3 border border-gray-100 rounded-lg bg-gray-50">
              <div className="flex-1 min-w-0">
                <div className="text-xs uppercase tracking-wide text-gray-500">{v.vendorName}</div>
                <div className="text-base font-semibold text-gray-900 truncate">{displayLabel}</div>
                {def && !selectedNetwork && (
                  <div className="text-xs text-gray-500">Vendor default: {def.title}</div>
                )}
              </div>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => openEditModal(v.vendorId)}
                  className="inline-flex items-center gap-1 px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-100"
                >
                  <Pencil className="h-4 w-4" />
                  Edit
                </button>
              )}
            </div>
          );
        })}
      </div>

      {editingVendorId && (() => {
        const vendor = distinctVendors.find((v) => v.vendorId === editingVendorId);
        const list = networksByVendor[editingVendorId] || [];
        const currentId = value[editingVendorId] ?? '';
        const isImmediateImpact = !!(autoSave && persistUrl);
        const impactSubject = scopeKind === 'household' ? 'household member ID cards' : 'group member ID cards';
        const changed = (pendingNetworkId || '') !== (currentId || '');
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
            onClick={closeEditModal}
          >
            <div
              className="bg-white rounded-lg shadow-xl max-w-md w-full p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <h4 className="text-lg font-semibold text-gray-900 mb-2">
                Change network — {vendor?.vendorName || 'Vendor'}
              </h4>
              <p className="text-sm text-gray-600 mb-4">
                Pick the network this group should use for this vendor. Members of this group
                will see the matching ID card variation.
              </p>
              <label className="block text-sm font-medium text-gray-700 mb-1">Network</label>
              <select
                value={pendingNetworkId}
                onChange={(e) => setPendingNetworkId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary bg-white"
              >
                <option value="">Use vendor default</option>
                {list
                  .filter((n) => n.isActive !== false)
                  .map((n) => (
                    <option key={n.vendorNetworkId} value={n.vendorNetworkId}>
                      {n.title}{n.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
              </select>

              {isImmediateImpact && changed && (
                <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-yellow-50 border border-yellow-200">
                  <AlertTriangle className="h-5 w-5 text-yellow-600 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-yellow-900">
                    Changing the network will impact all {impactSubject} immediately, are you sure?
                  </p>
                </div>
              )}

              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeEditModal}
                  className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmEdit}
                  disabled={!changed}
                  className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isImmediateImpact ? 'Yes, change network' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

export default VendorNetworkSelections;
