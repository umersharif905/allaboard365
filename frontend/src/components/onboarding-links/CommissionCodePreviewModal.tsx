import { Loader2, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import SearchableDropdown from '../common/SearchableDropdown';
import CommissionTierTable from '../products/CommissionTierTable';
import { useAgentProducts } from '../../hooks/agent/useAgentProducts';
import { useAgentProductCommissionPreview } from '../../hooks/agent/useAgentProductCommissionPreview';

interface CommissionCode {
  CodeId?: string;
  CommissionCode: string;
  CommissionGroupId?: string | null;
  CommissionGroupName?: string | null;
  IsActive: boolean;
  GrantTierLevel?: number | null;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  code: CommissionCode | null;
  /** Pre-resolved by the link parent (LinkDetailsModal). Used when the code
   *  itself doesn't carry an explicit CommissionGroupId. */
  ownerCommissionGroupId: string | null;
  /** Used in the header pill — same labelForTier pulled from the manager so
   *  display copy stays consistent without re-fetching CommissionLevels. */
  tierLabel?: string | null;
}

/** Preview the commissions an agent recruited via this onboarding code would
 *  receive for a chosen product. Reuses the same per-tier card list rendered
 *  inside SubscribedProductDetailsModal — no duplicate JSX, no new endpoint.
 *
 *  Auth-gated by the parent (eye-icon visible only for TenantAdmin/SysAdmin)
 *  because the backend's tenant-viewer commission-preview path requires that
 *  role to honour an arbitrary commissionGroupId override.
 */
const CommissionCodePreviewModal: React.FC<Props> = ({
  isOpen,
  onClose,
  code,
  ownerCommissionGroupId,
  tierLabel
}) => {
  const [productId, setProductId] = useState<string>('');

  const { data: products = [], isLoading: productsLoading } = useAgentProducts();

  const productOptions = useMemo(() => {
    return (products || [])
      .filter((p) => (p.subscriptionStatus || '').toLowerCase() === 'active')
      .map((p) => ({
        id: p.productId,
        label: p.productName,
        value: p.productId
      }));
  }, [products]);

  const resolvedGroupId =
    (code?.CommissionGroupId && code.CommissionGroupId.trim()) || ownerCommissionGroupId || null;

  const { data: preview, isLoading: previewLoading, error: previewError } =
    useAgentProductCommissionPreview(productId || null, isOpen && !!productId, {
      tenantViewer: true,
      commissionGroupId: resolvedGroupId
    });

  if (!isOpen || !code) return null;

  const grantTier = code.GrantTierLevel ?? null;
  const groupName = code.CommissionGroupName || preview?.commissionGroupName || null;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div className="relative bg-white rounded-lg shadow-xl border border-gray-200 max-w-3xl w-full max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-6 border-b border-gray-200 flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Commission preview {tierLabel ? `— ${tierLabel}` : ''}
            </h2>
            <div className="mt-1 text-sm text-gray-600 space-y-0.5">
              <p>
                Code: <span className="font-mono">{code.CommissionCode}</span>
                {grantTier != null && tierLabel && (
                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                    {tierLabel}
                  </span>
                )}
              </p>
              {groupName ? (
                <p>Commission group: <span className="text-gray-900 font-medium">{groupName}</span></p>
              ) : (
                <p className="text-amber-700">No commission group resolved for this code.</p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 min-h-0 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Product</label>
            <SearchableDropdown
              options={productOptions}
              value={productId}
              onChange={(v) => setProductId(v)}
              placeholder={productsLoading ? 'Loading products…' : 'Select a product'}
              searchPlaceholder="Search products…"
              loading={productsLoading}
              disabled={productsLoading || productOptions.length === 0}
              className="w-full"
            />
          </div>

          {!productId ? (
            <p className="text-sm text-gray-500 italic">
              Pick a product to see the commission ladder for this code.
            </p>
          ) : !resolvedGroupId ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              No commission group resolved — preview unavailable.
            </div>
          ) : previewLoading ? (
            <div className="flex items-center gap-2 text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading commission preview…
            </div>
          ) : previewError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              Could not load commission preview.
            </div>
          ) : !preview || !preview.hasPayout ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
              {preview?.message || 'This product does not pay out commission.'}
            </div>
          ) : (
            <>
              {preview.ruleName && (
                <div>
                  <h3 className="text-sm font-medium text-gray-900">{preview.ruleName}</h3>
                  {preview.ruleSource === 'product' && (
                    <p className="text-xs text-gray-500 mt-0.5">This product</p>
                  )}
                  {preview.ruleSource === 'allProducts' && (
                    <p className="text-xs text-gray-500 mt-0.5">All products (default)</p>
                  )}
                </div>
              )}
              <CommissionTierTable
                rows={preview.rows}
                viewerTenant
                highlightLevel={grantTier}
                emptyMessage={`No payout configured for level ${grantTier ?? '—'} on this product.`}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default CommissionCodePreviewModal;
