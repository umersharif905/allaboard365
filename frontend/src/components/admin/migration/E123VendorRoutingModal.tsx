import { X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { E123VendorRoutingPreview, VendorBucketChoice } from '../../../services/e123Migration.service';

interface Props {
  isOpen: boolean;
  preview: E123VendorRoutingPreview | null;
  productLabel?: string;
  loading?: boolean;
  onClose: () => void;
  onConfirm: (overrides: Record<string, VendorBucketChoice>) => void;
}

export default function E123VendorRoutingModal({
  isOpen,
  preview,
  productLabel,
  loading = false,
  onClose,
  onConfirm
}: Props) {
  const [choices, setChoices] = useState<Record<string, VendorBucketChoice>>({});

  useEffect(() => {
    if (!preview?.vendors?.length) {
      setChoices({});
      return;
    }
    const next: Record<string, VendorBucketChoice> = {};
    for (const vendor of preview.vendors) {
      next[vendor.routingKey] = vendor.selectedBucket;
    }
    setChoices(next);
  }, [preview]);

  if (!isOpen || !preview) return null;

  const handleConfirm = () => {
    onConfirm(choices);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-lg bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Vendor cost routing</h2>
            <p className="mt-1 text-sm text-gray-600">
              {productLabel
                ? `E123 vendor costs for ${productLabel} — choose once per vendor label.`
                : 'Choose once per vendor label how E123 payees map into the product wizard.'}
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
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
            <strong>Net rate</strong> = primary vendor payee on the product.
            {' '}<strong>Override rate</strong> = misc payees (Lyric, partners, admin) you can wire to ACH overrides later.
            {' '}<strong>Don&apos;t include</strong> = skip the cost in product pricing (default for merchant / processing fees).
            Each choice applies to <strong>all pricing tiers</strong>.
          </div>

          {preview.missingSnapshot ? (
            <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
              No CSV catalog snapshot found — upload Vendor Costs with the product catalog first.
            </div>
          ) : null}

          <div className="overflow-hidden rounded-lg border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Vendor</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Amount</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Applies to</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Route to</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {preview.vendors.map((vendor) => (
                  <tr key={vendor.routingKey}>
                    <td className="px-3 py-2 text-gray-900">
                      <div className="font-medium">{vendor.vendorName}</div>
                      {vendor.vendorId ? (
                        <div className="text-xs text-gray-500">Agent {vendor.vendorId}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-gray-800">{vendor.amountLabel}</td>
                    <td className="px-3 py-2 text-gray-600">{vendor.appliesTo}</td>
                    <td className="px-3 py-2">
                      <select
                        value={choices[vendor.routingKey] || vendor.selectedBucket}
                        onChange={(event) => {
                          const value = event.target.value as VendorBucketChoice;
                          setChoices((prev) => ({ ...prev, [vendor.routingKey]: value }));
                        }}
                        className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                      >
                        <option value="net">Net rate (vendor)</option>
                        <option value="override">Override rate (misc payee)</option>
                        <option value="exclude">Don&apos;t include</option>
                      </select>
                      {vendor.isMerchantFee && (choices[vendor.routingKey] || vendor.selectedBucket) === 'exclude' ? (
                        <div className="mt-1 text-xs text-gray-500">Merchant / processing fees are excluded from MSRP by default.</div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
            disabled={loading || preview.vendors.length === 0}
          >
            {loading ? 'Opening wizard…' : 'Continue to product wizard'}
          </button>
        </div>
      </div>
    </div>
  );
}
