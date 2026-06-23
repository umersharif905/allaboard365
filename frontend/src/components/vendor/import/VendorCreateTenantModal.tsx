import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle, Loader2, X } from 'lucide-react';
import { apiService } from '../../../services/api.service';

export interface VendorCreateTenantPayload {
  name: string;
  contactEmail: string;
  contactPhone?: string;
  primaryAddress?: string;
  primaryCity?: string;
  primaryState?: string;
  primaryZip?: string;
  defaultUrlPath: string;
  isExternal: boolean;
  productIds: string[];
}

interface VendorProductOption {
  productId: string;
  name: string;
  status?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

const VendorCreateTenantModal: React.FC<Props> = ({ open, onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [primaryAddress, setPrimaryAddress] = useState('');
  const [primaryCity, setPrimaryCity] = useState('');
  const [primaryState, setPrimaryState] = useState('');
  const [primaryZip, setPrimaryZip] = useState('');
  const [defaultUrlPath, setDefaultUrlPath] = useState('');
  const [isExternal, setIsExternal] = useState(true);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [products, setProducts] = useState<VendorProductOption[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [urlPathLoading, setUrlPathLoading] = useState(false);
  const [urlPathAvailability, setUrlPathAvailability] = useState<boolean | null>(null);
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setName('');
    setContactEmail('');
    setContactPhone('');
    setPrimaryAddress('');
    setPrimaryCity('');
    setPrimaryState('');
    setPrimaryZip('');
    setDefaultUrlPath('');
    setIsExternal(true);
    setSelectedProductIds([]);
    setUrlPathAvailability(null);
    setError(null);
  }, []);

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }

    setLoadingProducts(true);
    void apiService
      .get<{ success: boolean; data: Array<{ ProductId?: string; productId?: string; ProductName?: string; name?: string; Status?: string; status?: string; IsBundle?: boolean | number; isBundle?: boolean | number }> }>(
        '/api/me/vendor/products?excludeBundles=1'
      )
      .then((res) => {
        const rows = res.data || [];
        setProducts(
          rows
            .map((p) => ({
              productId: p.productId || p.ProductId || '',
              name: p.name || p.ProductName || 'Product',
              status: p.status || p.Status,
              isBundle: p.isBundle ?? p.IsBundle,
            }))
            .filter((p) => p.productId && !(p.isBundle === true || p.isBundle === 1))
            .map(({ productId, name, status }) => ({ productId, name, status }))
        );
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to load products');
      })
      .finally(() => setLoadingProducts(false));
  }, [open, reset]);

  const generateUrlPath = async (tenantName: string) => {
    if (!tenantName.trim()) return;
    setUrlPathLoading(true);
    try {
      const res = await apiService.post<{ success: boolean; data?: { urlPath: string; isAvailable: boolean } }>(
        '/api/tenant-identification/generate-path',
        { tenantName: tenantName.trim() }
      );
      if (res.success && res.data?.urlPath) {
        setDefaultUrlPath(res.data.urlPath);
        setUrlPathAvailability(res.data.isAvailable ?? true);
      }
    } catch {
      setError('Failed to generate URL path');
    } finally {
      setUrlPathLoading(false);
    }
  };

  const checkUrlPath = async (path: string) => {
    if (!path.trim()) {
      setUrlPathAvailability(null);
      return;
    }
    setCheckingAvailability(true);
    try {
      const res = await apiService.get<{ success: boolean; data?: { isAvailable: boolean } }>(
        `/api/tenant-identification/check-availability/${encodeURIComponent(path.trim())}`
      );
      setUrlPathAvailability(res.data?.isAvailable ?? false);
    } catch {
      setUrlPathAvailability(false);
    } finally {
      setCheckingAvailability(false);
    }
  };

  const toggleProduct = (productId: string) => {
    setSelectedProductIds((prev) =>
      prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId]
    );
  };

  const validate = (): string | null => {
    if (!name.trim()) return 'Company name is required';
    if (!contactEmail.trim()) return 'Contact email is required';
    if (!/\S+@\S+\.\S+/.test(contactEmail)) return 'Enter a valid email address';
    if (!defaultUrlPath.trim()) return 'URL path is required';
    if (urlPathAvailability === false) return 'URL path is not available';
    if (selectedProductIds.length === 0) return 'Select at least one of your products';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload: VendorCreateTenantPayload = {
        name: name.trim(),
        contactEmail: contactEmail.trim(),
        contactPhone: contactPhone.trim() || undefined,
        primaryAddress: primaryAddress.trim() || undefined,
        primaryCity: primaryCity.trim() || undefined,
        primaryState: primaryState.trim() || undefined,
        primaryZip: primaryZip.trim() || undefined,
        defaultUrlPath: defaultUrlPath.trim().toLowerCase(),
        isExternal,
        productIds: selectedProductIds,
      };

      await apiService.post('/api/me/vendor/import/tenants', payload);
      onCreated();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create tenant');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-xl">
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <div className="flex justify-between items-start">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">New tenant</h2>
              <p className="text-sm text-gray-500 mt-1">
                Create a tenant and grant access to your products for eligibility import.
              </p>
            </div>
            <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600" disabled={saving}>
              <X className="h-5 w-5" />
            </button>
          </div>

          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">{error}</div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Company name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => { if (!defaultUrlPath) void generateUrlPath(name); }}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                disabled={saving}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Contact email *</label>
              <input
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                disabled={saving}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Contact phone</label>
              <input
                type="tel"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                disabled={saving}
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
              <input
                type="text"
                value={primaryAddress}
                onChange={(e) => setPrimaryAddress(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                disabled={saving}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
              <input
                type="text"
                value={primaryCity}
                onChange={(e) => setPrimaryCity(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                disabled={saving}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
                <input
                  type="text"
                  maxLength={2}
                  value={primaryState}
                  onChange={(e) => setPrimaryState(e.target.value.toUpperCase())}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  disabled={saving}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">ZIP</label>
                <input
                  type="text"
                  value={primaryZip}
                  onChange={(e) => setPrimaryZip(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  disabled={saving}
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">URL path *</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={defaultUrlPath}
                onChange={(e) => setDefaultUrlPath(e.target.value.toLowerCase())}
                onBlur={() => void checkUrlPath(defaultUrlPath)}
                placeholder="acme-health"
                className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm font-mono"
                disabled={saving}
              />
              <button
                type="button"
                onClick={() => void generateUrlPath(name)}
                disabled={saving || urlPathLoading || !name.trim()}
                className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
              >
                {urlPathLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Suggest'}
              </button>
            </div>
            {checkingAvailability && <p className="text-xs text-gray-500 mt-1">Checking availability…</p>}
            {urlPathAvailability === true && (
              <p className="text-xs text-green-600 mt-1 flex items-center gap-1">
                <CheckCircle className="h-3 w-3" /> Available
              </p>
            )}
            {urlPathAvailability === false && (
              <p className="text-xs text-red-600 mt-1">This URL path is already in use</p>
            )}
          </div>

          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <h4 className="text-sm font-medium text-gray-900 mb-1">External billing</h4>
            <p className="text-xs text-gray-500 mb-3">
              External tenants use master invoicing without member-level NACHA or commission processing.
              Merchant Setup will be hidden and locked.
            </p>
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                id="vendorCreateTenantIsExternal"
                checked={isExternal}
                onChange={(e) => setIsExternal(e.target.checked)}
                disabled={saving}
                className="w-4 h-4 text-oe-primary bg-gray-100 border-gray-300 rounded focus:ring-oe-primary flex-shrink-0 mt-0.5"
              />
              <div>
                <label htmlFor="vendorCreateTenantIsExternal" className="text-sm font-medium text-gray-900 cursor-pointer">
                  External billing tenant
                </label>
                <p className="text-xs text-gray-500 mt-1">
                  Typically enabled for vendor partner tenants. Disable only if this tenant will collect
                  member payments through OpenEnroll Merchant Setup.
                </p>
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">Products *</label>
              <span className="text-xs text-gray-500">{selectedProductIds.length} selected</span>
            </div>
            {loadingProducts ? (
              <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading your products…
              </div>
            ) : products.length === 0 ? (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-3">
                No active products found for your vendor account.
              </p>
            ) : (
              <div className="border border-gray-200 rounded-md max-h-48 overflow-y-auto divide-y divide-gray-100">
                {products.map((p) => (
                  <label
                    key={p.productId}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={selectedProductIds.includes(p.productId)}
                      onChange={() => toggleProduct(p.productId)}
                      disabled={saving}
                      className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                    />
                    <span className="flex-1">{p.name}</span>
                    {p.status && p.status !== 'Active' && (
                      <span className="text-xs text-gray-400">{p.status}</span>
                    )}
                  </label>
                ))}
              </div>
            )}
            <p className="text-xs text-gray-500 mt-1">At least one product is required. Bundles are excluded — select your vendor products only.</p>
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || loadingProducts || products.length === 0}
              className="px-4 py-2 text-sm bg-oe-primary text-white rounded-md hover:bg-oe-primary-dark disabled:opacity-50 flex items-center gap-2"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Create tenant
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default VendorCreateTenantModal;
