import { Loader2, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiService } from '../../services/api.service';
import type { ApiResponse } from '../../types/index';

export interface ProductSubscriberRow {
  subscriptionId: string;
  tenantId: string;
  tenantName: string;
  subscriptionStatus: string;
  subscriptionDate?: string;
  isProductOwner: boolean;
}

interface ProductSubscribersPanelProps {
  productId: string;
  productName?: string;
  /** When true, list copy targets product owners managing other tenants. */
  ownerView?: boolean;
  onChanged?: () => void;
}

const ProductSubscribersPanel: React.FC<ProductSubscribersPanelProps> = ({
  productId,
  productName,
  ownerView = false,
  onChanged
}) => {
  const [subscribers, setSubscribers] = useState<ProductSubscriberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingTenantId, setRemovingTenantId] = useState<string | null>(null);

  const otherSubscribers = useMemo(
    () => subscribers.filter((row) => !row.isProductOwner),
    [subscribers]
  );

  const loadSubscribers = useCallback(async () => {
    if (!productId) return;
    try {
      setLoading(true);
      setError(null);
      const response = await apiService.get<ApiResponse<ProductSubscriberRow[]>>(
        `/api/products/${productId}/subscribers`
      );
      if (response.success) {
        setSubscribers(response.data || []);
      } else {
        setError(response.message || 'Failed to load subscribers');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load subscribers');
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void loadSubscribers();
  }, [loadSubscribers]);

  const buildConfirmMessage = (row: ProductSubscriberRow) => {
    const productLabel = productName ? `"${productName}"` : 'this product';
    if (ownerView) {
      return [
        `Remove ${row.tenantName} as a subscriber to ${productLabel}?`,
        '',
        'They will no longer be able to offer or configure this product for their organization.',
        'They can subscribe again from the marketplace later if you allow it.'
      ].join('\n');
    }
    return [
      `Remove ${row.tenantName} from ${productLabel}'s subscribers?`,
      '',
      'They will no longer be able to offer this product for their organization.'
    ].join('\n');
  };

  const handleRemove = async (row: ProductSubscriberRow) => {
    if (row.isProductOwner) return;
    if (!confirm(buildConfirmMessage(row))) {
      return;
    }

    try {
      setRemovingTenantId(row.tenantId);
      const response = await apiService.delete<ApiResponse<{ message: string }>>(
        `/api/products/${productId}/subscribers/${row.tenantId}`
      );
      if (response.success) {
        await loadSubscribers();
        onChanged?.();
      } else {
        setError(response.message || 'Failed to remove subscriber');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to remove subscriber');
    } finally {
      setRemovingTenantId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading subscribers…
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  const heading = ownerView
    ? `Other tenants offering ${productName ? `"${productName}"` : 'this product'}`
    : 'Product subscribers';

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">{heading}</h3>
        <p className="text-sm text-gray-600 mt-1">
          {otherSubscribers.length === 0
            ? 'No other tenants are currently subscribed.'
            : `${otherSubscribers.length} tenant${otherSubscribers.length === 1 ? '' : 's'} subscribed besides your organization.`}
        </p>
      </div>

      {otherSubscribers.length === 0 ? null : (
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tenant</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Since</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {otherSubscribers.map((row) => (
                <tr key={row.subscriptionId || row.tenantId} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm text-gray-900">{row.tenantName}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{row.subscriptionStatus}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">
                    {row.subscriptionDate ? new Date(row.subscriptionDate).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => void handleRemove(row)}
                      disabled={removingTenantId === row.tenantId}
                      className="inline-flex items-center justify-center p-2 border border-red-200 rounded-md text-red-600 bg-white hover:bg-red-50 disabled:opacity-50"
                      title="Remove subscriber"
                    >
                      {removingTenantId === row.tenantId ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default ProductSubscribersPanel;
