// frontend/src/components/enrollment-wizard/components/NetworkSelectionModal.tsx
//
// Modal for picking the ID card network per vendor, opened from the product
// card during enrollment. One row per vendor that (a) has IDCardData
// NetworkVariations on the product/component AND (b) has 2+ active
// VendorNetworks. Vendors that fail either gate are silently hidden.
//
// Selections returned to the parent are { vendorId: vendorNetworkId | '' }.
// '' means "use default" — submit handler skips writes for empty values.

import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';

export interface VendorNetwork {
  vendorNetworkId: string;
  vendorId: string;
  title: string;
  isDefault: boolean;
  isActive: boolean;
}

export interface NetworkSelectionVendor {
  vendorId: string;
  vendorName: string;
  /** IDCardData of the product/component this vendor is the vendor for. Used to
   * confirm there's at least one NetworkVariations entry for this vendor. */
  idCardData: any;
}

/** Loader signature shared by both the modal and the row component. Implementations
 * differ between the public enrollment-link flow (uses linkToken-scoped endpoint)
 * and the admin group-creation flow (uses /api/vendors/:vendorId/networks). */
export type VendorNetworksLoader = (vendorId: string) => Promise<VendorNetwork[]>;

interface Props {
  isOpen: boolean;
  /** Cache key seed unique to this caller (e.g. linkToken or 'group-admin'). */
  cacheKey: string;
  fetchVendorNetworks: VendorNetworksLoader;
  vendors: NetworkSelectionVendor[];
  /** When the bundle has multiple qualifying vendors, the parent passes a
   * product-name label per vendor so each modal row clearly identifies which
   * plan it applies to. Single-row case leaves this undefined → generic label. */
  productLabelByVendorId?: Record<string, string>;
  initialSelections: Record<string, string>;
  onClose: () => void;
  onConfirm: (selections: Record<string, string>) => void;
}

function vendorHasVariations(vendor: NetworkSelectionVendor): boolean {
  const idCard = vendor.idCardData;
  if (!idCard || typeof idCard !== 'object') return false;
  const variations = idCard.NetworkVariations;
  return !!variations && typeof variations === 'object' && Object.keys(variations).length > 0;
}

export default function NetworkSelectionModal({
  isOpen,
  cacheKey,
  fetchVendorNetworks,
  vendors,
  productLabelByVendorId,
  initialSelections,
  onClose,
  onConfirm
}: Props) {
  // Local working copy. Committed to parent only on Confirm.
  const [working, setWorking] = useState<Record<string, string>>(initialSelections);
  useEffect(() => {
    if (isOpen) setWorking(initialSelections);
  }, [isOpen, initialSelections]);

  const queries = useQueries({
    queries: vendors.map((v) => ({
      queryKey: ['vendor-networks', cacheKey, v.vendorId],
      queryFn: () => fetchVendorNetworks(v.vendorId),
      enabled: isOpen && !!v.vendorId,
      staleTime: 5 * 60 * 1000
    }))
  });

  const isLoading = queries.some((q) => q.isLoading);

  const rows = useMemo(() => {
    return vendors
      .map((v, i) => {
        const networks = (queries[i]?.data ?? []).filter((n: VendorNetwork) => n.isActive !== false);
        const defaultNetwork = networks.find((n) => n.isDefault) ?? null;
        const qualifies = networks.length >= 2 && vendorHasVariations(v);
        return { vendor: v, networks, defaultNetwork, qualifies };
      })
      .filter((r) => r.qualifies);
  }, [vendors, queries]);

  if (!isOpen) return null;

  const handleConfirm = () => {
    // Normalize: if user selected the default for a vendor, store as '' so the
    // wizard skips the HouseholdVendorNetworks write for that vendor.
    const normalized: Record<string, string> = {};
    for (const r of rows) {
      const picked = working[r.vendor.vendorId] ?? '';
      if (r.defaultNetwork && picked === r.defaultNetwork.vendorNetworkId) {
        normalized[r.vendor.vendorId] = '';
      } else {
        normalized[r.vendor.vendorId] = picked;
      }
    }
    onConfirm(normalized);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        data-testid="network-selection-modal"
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h4 className="text-lg font-semibold text-gray-900">Choose Provider Network</h4>
            <p className="text-sm text-gray-600 mt-1">
              Pick the provider network you want for your ID card.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {isLoading && (
          <div className="py-8 text-center text-sm text-gray-500">Loading networks…</div>
        )}

        {!isLoading && rows.length === 0 && (
          <div className="py-6 text-center text-sm text-gray-600">
            No alternate networks available — your ID card will use the default.
          </div>
        )}

        {!isLoading && rows.length > 0 && (
          <div className="space-y-4">
            {rows.map((r) => {
              const effectiveValue = working[r.vendor.vendorId] || r.defaultNetwork?.vendorNetworkId || '';
              const productLabel = productLabelByVendorId?.[r.vendor.vendorId];
              const rowLabel = productLabel ? `${productLabel} Provider Network` : 'Provider Network';
              return (
                <div key={r.vendor.vendorId}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {rowLabel}
                  </label>
                  <select
                    data-testid={`network-modal-select-${r.vendor.vendorId}`}
                    value={effectiveValue}
                    onChange={(e) =>
                      setWorking((prev) => ({ ...prev, [r.vendor.vendorId]: e.target.value }))
                    }
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary bg-white"
                  >
                    {r.networks.map((n) => (
                      <option key={n.vendorNetworkId} value={n.vendorNetworkId}>
                        {n.title}
                        {n.isDefault ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isLoading || rows.length === 0}
            className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
