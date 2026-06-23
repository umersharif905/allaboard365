import { useEffect, useState } from 'react';
import { API_CONFIG } from '../../../config/api';
import { apiService } from '../../../services/apiServices';
import { StepProps, Vendor } from '../../../types/sysadmin/addproductswizard.types';

export default function Step1VendorSelection({
  formData,
  updateFormData,
  isVendorAdmin = false,
  editingProductId
}: StepProps) {
  const [availableVendors, setAvailableVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [vendorProducts, setVendorProducts] = useState<Array<{ ProductId: string; Name: string; VendorId: string }>>([]);
  const [vendorProductsLoading, setVendorProductsLoading] = useState(false);

  // Initial mount - log what we received
  useEffect(() => {
    console.log('Step1VendorSelection mounted with formData:', {
      vendorId: formData.vendorId,
      isVendorPricing: formData.isVendorPricing,
      vendorCommission: formData.vendorCommission
    });
  }, []);

  // Fetch available vendors
  const fetchAvailableVendors = async () => {
    try {
      setLoading(true);
      const baseUrl = API_CONFIG.BASE_URL;
      const token = localStorage.getItem('accessToken') || localStorage.getItem('token');
      
      console.log('Fetching vendors from:', `/api/vendors`);
      
      const data = await apiService.get<{ success: boolean; data?: Vendor[] }>('/api/vendors');
      console.log('Vendors response:', data);
      
      if (data.success && Array.isArray(data.data)) {
        setAvailableVendors(data.data);
        console.log('Set vendors:', data.data);
      }
    } catch (error) {
      console.error('Error fetching vendors:', error);
      setAvailableVendors([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAvailableVendors();
  }, []);

  // Same-vendor products for optional eligibility vendor group ID fallback (exclude current product when editing)
  useEffect(() => {
    let cancelled = false;
    const loadVendorProducts = async () => {
      if (!formData.vendorId) {
        setVendorProducts([]);
        return;
      }
      setVendorProductsLoading(true);
      try {
        const res = await apiService.get<{
          success?: boolean;
          products?: Array<{ ProductId: string; Name: string; VendorId: string }>;
        }>('/api/products');
        if (cancelled) return;
        const list = Array.isArray(res?.products) ? res.products : [];
        const vid = String(formData.vendorId).toLowerCase();
        const exclude = editingProductId ? String(editingProductId).toLowerCase() : '';
        setVendorProducts(
          list.filter(
            (p) =>
              p.VendorId &&
              String(p.VendorId).toLowerCase() === vid &&
              (!exclude || String(p.ProductId).toLowerCase() !== exclude)
          )
        );
      } catch {
        if (!cancelled) setVendorProducts([]);
      } finally {
        if (!cancelled) setVendorProductsLoading(false);
      }
    };
    loadVendorProducts();
    return () => {
      cancelled = true;
    };
  }, [formData.vendorId, editingProductId]);

  // Log vendor data for debugging
  useEffect(() => {
    console.log('Step1 - Current vendor data:', {
      vendorId: formData.vendorId,
      isVendorPricing: formData.isVendorPricing,
      vendorCommission: formData.vendorCommission,
      availableVendors: availableVendors.length,
      selectedVendor: availableVendors.find(v => v.Id === formData.vendorId)
    });
  }, [formData.vendorId, formData.isVendorPricing, formData.vendorCommission, availableVendors]);

  const selectedVendor = availableVendors.find(v => v.Id === formData.vendorId);

  const handleCommissionChange = (value: string) => {
    // Allow empty string
    if (value === '') {
      updateFormData({ vendorCommission: 0 });
      return;
    }

    // Allow numbers with optional decimal point and any number of decimal places
    const regex = /^\d*\.?\d*$/;
    
    if (regex.test(value)) {
      const numValue = parseFloat(value);
      // Only update if it's a valid number or ends with decimal point (for typing)
      if (!isNaN(numValue)) {
        updateFormData({ vendorCommission: numValue });
      } else if (value.endsWith('.') && (value.match(/\./g) || []).length === 1) {
        // Allow typing decimal point
        updateFormData({ vendorCommission: parseFloat(value + '0') || 0 });
      }
    }
  };

  return (
    <div className="space-y-6">
      <h3 className="text-xl font-bold text-oe-text">Select Vendor</h3>
      
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
        </div>
      ) : (
        <>
          <div>
            <label className="form-label">Select Vendor *</label>
            {isVendorAdmin && formData.vendorId ? (
              // For Vendor Admin: Show read-only field with their vendor
              <div>
                <input
                  type="text"
                  value={selectedVendor ? `${selectedVendor.VendorName}${selectedVendor.City && selectedVendor.State ? ` - ${selectedVendor.City}, ${selectedVendor.State}` : ''}` : 'Loading...'}
                  readOnly
                  className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-50 text-gray-700 cursor-not-allowed"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Your vendor is automatically selected. You can only create products for your own vendor.
                </p>
              </div>
            ) : (
              // For Sys Admin: Show dropdown with all vendors
              <>
                <select
                  value={formData.vendorId || ''}
                  onChange={(e) => updateFormData({ vendorId: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  required
                >
                  <option value="">Select a Vendor</option>
                  {availableVendors.map(vendor => (
                    <option key={vendor.Id} value={vendor.Id}>
                      {vendor.VendorName}
                      {vendor.City && vendor.State && ` - ${vendor.City}, ${vendor.State}`}
                    </option>
                  ))}
                </select>
                {!formData.vendorId && (
                  <p className="text-oe-error text-sm mt-1">Please select a vendor to continue</p>
                )}
                {availableVendors.length === 0 && (
                  <p className="text-oe-warning text-sm mt-1">
                    No vendors available. Please create a vendor first.
                  </p>
                )}
              </>
            )}
          </div>

          {formData.vendorId && (
            <>
              {selectedVendor ? (
                <div className="card hover-lift mt-4">
                  <h4 className="font-semibold text-oe-text mb-3">Vendor Details</h4>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-gray-600">Name:</span>
                      <span className="ml-2 font-medium">{selectedVendor.VendorName}</span>
                    </div>
                    {selectedVendor.ContactName && (
                      <div>
                        <span className="text-gray-600">Contact:</span>
                        <span className="ml-2 font-medium">{selectedVendor.ContactName}</span>
                      </div>
                    )}
                    {selectedVendor.Email && (
                      <div>
                        <span className="text-gray-600">Email:</span>
                        <span className="ml-2 font-medium">{selectedVendor.Email}</span>
                      </div>
                    )}
                    {selectedVendor.Phone && (
                      <div>
                        <span className="text-gray-600">Phone:</span>
                        <span className="ml-2 font-medium">{selectedVendor.Phone}</span>
                      </div>
                    )}
                    {selectedVendor.City && selectedVendor.State && (
                      <div>
                        <span className="text-gray-600">Location:</span>
                        <span className="ml-2 font-medium">{selectedVendor.City}, {selectedVendor.State}</span>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-md">
                  <p className="text-sm text-yellow-800">
                    Loading vendor details... (Vendor ID: {formData.vendorId})
                  </p>
                </div>
              )}
            </>
          )}

          <div className="space-y-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.vendorGroupIdProductType !== '' && formData.vendorGroupIdProductType !== 'None' && formData.vendorGroupIdProductType != null}
                onChange={(e) => {
                  if (e.target.checked) {
                    updateFormData({ vendorGroupIdProductType: '0' });
                  } else {
                    updateFormData({
                      vendorGroupIdProductType: 'None',
                      eligibilityVendorGroupFallbackProductId: '',
                      showGroupIdOnIDCard: false
                    });
                  }
                }}
                className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
              />
              <span className="form-label mb-0">Use vendor group ID for this product</span>
            </label>
            <p className="text-xs text-gray-500">
              Enable to assign a vendor-specific group ID (e.g. for ARM: 90500, 90501). Leave unchecked for products that don&apos;t need a group ID (e.g. Vision, Dental).
            </p>
            {(formData.vendorGroupIdProductType !== '' && formData.vendorGroupIdProductType !== 'None' && formData.vendorGroupIdProductType != null) && (
              <div>
                <label className="form-label">Vendor group ID offset</label>
                <input
                  type="number"
                  min={0}
                  max={9}
                  step={1}
                  value={formData.vendorGroupIdProductType === 'None' ? '' : (formData.vendorGroupIdProductType ?? '')}
                  onChange={(e) => {
                    const v = e.target.value;
                    updateFormData({ vendorGroupIdProductType: v === '' ? 'None' : v });
                  }}
                  placeholder="e.g. 0, 1, 2"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Number added to the group&apos;s base ID (e.g. 0=Master, 1=CoPay, 2=HSA).
                </p>
              </div>
            )}
            {(formData.vendorGroupIdProductType !== '' && formData.vendorGroupIdProductType !== 'None' && formData.vendorGroupIdProductType != null) && (
              <div className="mt-3">
                <label className="form-label">Individuals Group ID</label>
                <input
                  type="text"
                  value={formData.eligibilityIndividualVendorGroupId ?? ''}
                  onChange={(e) => updateFormData({ eligibilityIndividualVendorGroupId: e.target.value.trim() || '' })}
                  placeholder="e.g. 10542 (used when member has no group)"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Used in eligibility export when the member has no group. One value per product; leave blank if not applicable.
                </p>
              </div>
            )}
            {(formData.vendorGroupIdProductType !== '' && formData.vendorGroupIdProductType !== 'None' && formData.vendorGroupIdProductType != null) && (
              <div className="mt-3">
                <label className="form-label">Plan ID</label>
                <input
                  type="text"
                  value={formData.planId ?? ''}
                  onChange={(e) => updateFormData({ planId: e.target.value.trim() || '' })}
                  placeholder="e.g. PLAN-2024-001 (optional)"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Optional vendor-assigned plan identifier (e.g. SBC plan ID or contract number). Included in vendor exports when set.
                </p>
              </div>
            )}
            {(formData.vendorGroupIdProductType !== '' && formData.vendorGroupIdProductType !== 'None' && formData.vendorGroupIdProductType != null) && (
              <div className="mt-3">
                <label className="form-label">Use other product&apos;s vendor group ID (before Master)</label>
                <select
                  value={formData.eligibilityVendorGroupFallbackProductId ?? ''}
                  onChange={(e) =>
                    updateFormData({ eligibilityVendorGroupFallbackProductId: e.target.value || '' })
                  }
                  disabled={!formData.vendorId || vendorProductsLoading}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-50 disabled:opacity-60"
                >
                  <option value="">None</option>
                  {vendorProducts.map((p) => (
                    <option key={p.ProductId} value={p.ProductId}>
                      {p.Name || p.ProductId}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Optional. Eligibility export uses this product&apos;s resolved group ID for the group before this product&apos;s Master when set.
                </p>
              </div>
            )}
          </div>

          {/* Hidden — field retained on ProductFormData for API compatibility
          <div>
            <label className="form-label">Part Number</label>
            <input
              type="text"
              value={formData.partNumber || ''}
              onChange={(e) => updateFormData({ partNumber: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              placeholder="Enter part number or policy ID (optional)"
            />
          </div>
          */}

        </>
      )}
    </div>
  );
}