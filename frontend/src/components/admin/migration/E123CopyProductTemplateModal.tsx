import { Copy, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import SearchableDropdown from '../../common/SearchableDropdown';
import type { MigrationSubscribedProduct } from '../../../services/e123Migration.service';

const NO_COPY_ID = '__none__';

interface Props {
  isOpen: boolean;
  productLabel?: string;
  subscribedProducts: MigrationSubscribedProduct[];
  suggestedProductId?: string;
  loading?: boolean;
  onClose: () => void;
  onConfirm: (templateProductId: string | null) => void;
}

export default function E123CopyProductTemplateModal({
  isOpen,
  productLabel,
  subscribedProducts,
  suggestedProductId,
  loading = false,
  onClose,
  onConfirm
}: Props) {
  const [selectedId, setSelectedId] = useState(NO_COPY_ID);

  useEffect(() => {
    if (!isOpen) return;
    if (suggestedProductId && subscribedProducts.some((p) => p.productId === suggestedProductId)) {
      setSelectedId(suggestedProductId);
    } else {
      setSelectedId(NO_COPY_ID);
    }
  }, [isOpen, suggestedProductId, subscribedProducts]);

  const options = useMemo(
    () => [
      {
        id: NO_COPY_ID,
        value: NO_COPY_ID,
        label: "Don't copy — start blank",
        sublabel: 'ID card, plan details, and documents will be empty'
      },
      ...subscribedProducts.map((product) => ({
        id: product.productId,
        value: product.productId,
        label: product.name,
        code: product.salesTypeLabel,
        sublabel: [
          product.vendorName ? `Vendor: ${product.vendorName}` : null,
          product.isBundle ? 'Bundle' : null,
          product.isHidden ? 'Hidden from agents' : null,
          product.catalogSource === 'owned' ? 'Tenant-owned' : product.catalogSource === 'both' ? 'Subscribed · Tenant-owned' : 'Subscribed'
        ].filter(Boolean).join(' · ')
      }))
    ],
    [subscribedProducts]
  );

  if (!isOpen) return null;

  const handleConfirm = () => {
    onConfirm(selectedId === NO_COPY_ID ? null : selectedId);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-xl rounded-lg bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <Copy className="h-5 w-5 text-indigo-600" />
              Copy product details
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              {productLabel
                ? `Optional: copy ID card, plan details, media, documents, and product info from an existing AB365 product into "${productLabel}".`
                : 'Optional: copy ID card, plan details, media, documents, and product info from an existing AB365 product.'}
              {' '}Pricing always comes from E123 — never copied.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <label className="block text-sm font-medium text-gray-700">Copy from AB365 product</label>
          <SearchableDropdown
            options={options}
            value={selectedId}
            onChange={setSelectedId}
            placeholder="Select a product to copy from..."
            searchPlaceholder="Search products..."
            showSublabel
            showCode
          />
          <p className="text-xs text-gray-500">
            Copied assets use existing blob URLs — no re-upload from your computer is required when you save the new product.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? 'Preparing wizard…' : 'Continue to wizard'}
          </button>
        </div>
      </div>
    </div>
  );
}
