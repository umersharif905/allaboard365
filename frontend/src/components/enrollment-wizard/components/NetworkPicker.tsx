// frontend/src/components/enrollment-wizard/components/NetworkPicker.tsx
//
// Renders the read-only "Provider Network" line on a product card during
// enrollment, with a pencil button that opens a modal for picking the network.
//
// One row per qualifying vendor (the product's own vendor + any bundle
// component vendors that have NetworkVariations). The pencil opens a single
// modal listing all qualifying vendors so the user can change them at once.
//
// Auto-opens the modal once when the product is first selected (the picker
// only renders when selected to begin with). Wrapper stops click propagation
// so clicking inside doesn't toggle the product card's selection.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import NetworkSelectionModal, {
  NetworkSelectionVendor,
  VendorNetwork,
  VendorNetworksLoader
} from './NetworkSelectionModal';

/**
 * Returns the list of vendor IDs that should drive a Provider Network picker on
 * a given product card (the product's own vendor, plus any bundle component
 * vendors when the product is a bundle).
 */
export function deriveCardVendorIds(product: any): string[] {
  const ids: string[] = [];
  const ownVendorId = product?.vendorId;
  if (ownVendorId) ids.push(String(ownVendorId));
  if (Array.isArray(product?.includedProducts)) {
    for (const inc of product.includedProducts) {
      const incVendorId = inc?.vendorId;
      if (incVendorId && !ids.includes(String(incVendorId))) ids.push(String(incVendorId));
    }
  }
  return ids;
}

/** True when product (or a bundle component) has NetworkVariations for the given vendor. */
export function productHasVariationsForVendor(product: any, vendorId: string): boolean {
  if (!vendorId) return false;
  const sameVendor = (vid: any) => String(vid || '') === String(vendorId);
  const checkOne = (idCard: any) => {
    if (!idCard || typeof idCard !== 'object') return false;
    const variations = idCard.NetworkVariations;
    return variations && typeof variations === 'object' && Object.keys(variations).length > 0;
  };
  if (sameVendor(product?.vendorId) && checkOne(product?.idCardData)) return true;
  if (Array.isArray(product?.includedProducts)) {
    for (const inc of product.includedProducts) {
      if (sameVendor(inc?.vendorId) && checkOne(inc?.idCardData)) return true;
    }
  }
  return false;
}

interface RowProps {
  cacheKey: string;
  fetchVendorNetworks: VendorNetworksLoader;
  vendor: NetworkSelectionVendor;
  selectedNetworkId: string;
  /** When the card has multiple network rows, prefix with the product/component
   * name so the user knows which plan it applies to. Single-row case stays
   * generic ("Provider Network"). */
  productLabel: string | null;
  onEdit: () => void;
}

/** Single read-only line: "[Product] Provider Network: <Title>" with a pencil button. */
function NetworkSelectionRow({ cacheKey, fetchVendorNetworks, vendor, selectedNetworkId, productLabel, onEdit }: RowProps) {
  const { data: networks = [], isLoading } = useQuery<VendorNetwork[]>({
    queryKey: ['vendor-networks', cacheKey, vendor.vendorId],
    queryFn: () => fetchVendorNetworks(vendor.vendorId),
    enabled: !!vendor.vendorId,
    staleTime: 5 * 60 * 1000
  });

  const activeNetworks = useMemo(
    () => networks.filter((n) => n.isActive !== false),
    [networks]
  );
  const defaultNetwork = useMemo(() => activeNetworks.find((n) => n.isDefault), [activeNetworks]);

  // Hide row entirely when the vendor doesn't actually qualify (≥2 networks).
  if (isLoading) return null;
  if (activeNetworks.length < 2) return null;

  const effectiveId = selectedNetworkId || defaultNetwork?.vendorNetworkId || '';
  const effectiveTitle =
    activeNetworks.find((n) => n.vendorNetworkId === effectiveId)?.title
    ?? defaultNetwork?.title
    ?? '—';

  const labelText = productLabel ? `${productLabel} Provider Network:` : 'Provider Network:';
  return (
    <div
      className="flex items-center gap-2 text-sm"
      data-testid={`network-picker-${vendor.vendorId}`}
    >
      <span className="text-gray-600">{labelText}</span>
      <span className="font-medium text-gray-900">{effectiveTitle}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        className="inline-flex items-center text-oe-primary hover:text-oe-dark"
        aria-label={`Change provider network${productLabel ? ` for ${productLabel}` : ''}`}
        data-testid={`network-picker-edit-${vendor.vendorId}`}
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

interface NetworkPickerForProductProps {
  product: any;
  /** Stable cache-key seed (e.g. enrollment link token, or `'group-admin'`). */
  cacheKey: string;
  /** Loader for a single vendor's active networks. Caller decides which endpoint to hit. */
  fetchVendorNetworks: VendorNetworksLoader;
  selections: Record<string, string>;
  onChange: (selections: Record<string, string>) => void;
  /** When this product is newly selected, set this to true to auto-open the modal once. */
  shouldAutoOpen: boolean;
  /** Called the first time the modal auto-opens for this product. */
  onAutoOpened: () => void;
}

export default function NetworkPickerForProduct({
  product,
  cacheKey,
  fetchVendorNetworks,
  selections,
  onChange,
  shouldAutoOpen,
  onAutoOpened
}: NetworkPickerForProductProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const autoOpenedRef = useRef(false);

  // Each qualifying vendor gets one row. The row's product label is the name
  // of the bundle component (or top-level product) that introduced this
  // vendor — used only when the card has multiple rows to disambiguate which
  // plan the network applies to.
  const vendorsWithSource = useMemo(() => {
    const vendorIds = deriveCardVendorIds(product).filter((vid) =>
      productHasVariationsForVendor(product, vid)
    );
    const includedByVendor = new Map<string, any>();
    if (Array.isArray(product?.includedProducts)) {
      for (const inc of product.includedProducts) {
        if (inc?.vendorId) includedByVendor.set(String(inc.vendorId), inc);
      }
    }
    return vendorIds.map((vid) => {
      const sourceProduct = String(product?.vendorId || '') === vid
        ? product
        : includedByVendor.get(vid);
      return {
        vendor: {
          vendorId: vid,
          vendorName: sourceProduct?.vendorName || 'Vendor',
          idCardData: sourceProduct?.idCardData
        } as NetworkSelectionVendor,
        productName: sourceProduct?.productName || sourceProduct?.name || ''
      };
    });
  }, [product]);

  const vendors: NetworkSelectionVendor[] = useMemo(
    () => vendorsWithSource.map((r) => r.vendor),
    [vendorsWithSource]
  );

  // Auto-open once when the product is newly selected and qualifies.
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (!shouldAutoOpen) return;
    if (vendors.length === 0) return;
    autoOpenedRef.current = true;
    setModalOpen(true);
    onAutoOpened();
  }, [shouldAutoOpen, vendors.length, onAutoOpened]);

  if (vendors.length === 0) return null;

  const showProductLabel = vendorsWithSource.length > 1;

  // Per-vendor product label map (vendorId -> product name) for the modal.
  const productLabelByVendorId = useMemo(() => {
    const map: Record<string, string> = {};
    vendorsWithSource.forEach(({ vendor, productName }) => {
      map[vendor.vendorId] = productName;
    });
    return map;
  }, [vendorsWithSource]);

  return (
    <div
      className="mt-3 space-y-1"
      onClick={(e) => e.stopPropagation()}
    >
      {vendorsWithSource.map(({ vendor, productName }) => (
        <NetworkSelectionRow
          key={vendor.vendorId}
          cacheKey={cacheKey}
          fetchVendorNetworks={fetchVendorNetworks}
          vendor={vendor}
          selectedNetworkId={selections[vendor.vendorId] ?? ''}
          productLabel={showProductLabel ? productName : null}
          onEdit={() => setModalOpen(true)}
        />
      ))}

      <NetworkSelectionModal
        isOpen={modalOpen}
        cacheKey={cacheKey}
        fetchVendorNetworks={fetchVendorNetworks}
        vendors={vendors}
        productLabelByVendorId={showProductLabel ? productLabelByVendorId : undefined}
        initialSelections={selections}
        onClose={() => setModalOpen(false)}
        onConfirm={(next) => {
          onChange({ ...selections, ...next });
          setModalOpen(false);
        }}
      />
    </div>
  );
}
