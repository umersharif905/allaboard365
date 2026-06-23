import { useEffect, useState } from 'react';
import { API_CONFIG } from '../../../config/api';
import { apiService } from '../../../services/apiServices';
import { StepProps, Tenant } from '../../../types/sysadmin/addproductswizard.types';
import { US_STATES } from '../../common/geographic-data';
import { PRODUCT_TYPES } from '../AddProductWizard';

export default function Step2BasicDetails({
  formData,
  updateFormData,
  isTenantAdmin = false,
  isVendorAdmin = false,
  isSysAdmin = false,
  editingProductId,
}: StepProps) {
  const [availableTenants, setAvailableTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const DEFAULT_OWNER_ID = '00000000-0000-0000-0000-000000000000';

  // Fetch available tenants
  const fetchAvailableTenants = async () => {
    // Skip tenant fetch for vendors
    if (isVendorAdmin) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const baseUrl = API_CONFIG.BASE_URL;
      const token = localStorage.getItem('accessToken');
      
      if (!token) {
        window.location.href = '/login';
        return;
      }
      
      let data;
      
      if (isTenantAdmin) {
        // For TenantAdmins, get current tenant info instead of all tenants
        data = await apiService.get<{ success: boolean; data?: Tenant }>('/api/me/tenant-admin/tenant');
      } else {
        // For SysAdmins, get all tenants
        data = await apiService.get<{ success: boolean; data?: Tenant[] }>('/api/tenants');
      }
      
      if (data.success) {
        if (isTenantAdmin) {
          // For TenantAdmin, wrap the single tenant in an array and auto-select it
          const tenant = data.data;
          setAvailableTenants([tenant]);
          // Automatically set the product owner to the current tenant
          updateFormData({ productOwnerId: tenant.TenantId });
        } else if (isSysAdmin && Array.isArray(data.data)) {
          setAvailableTenants(data.data);
        } else if (Array.isArray(data.data)) {
          // Legacy fallback when role flags are not passed
          setAvailableTenants(data.data);
        } else {
          setAvailableTenants([]);
        }
      } else {
        setAvailableTenants([]);
      }
    } catch (error) {
      console.error('Error fetching tenants:', error);
      setAvailableTenants([]);
      // For vendors, silently set default owner ID (no error message)
      if (!isTenantAdmin && formData.productOwnerId === DEFAULT_OWNER_ID) {
        // Already set, no need to show error
      } else if (!isTenantAdmin) {
        // Set default owner ID for vendors
        updateFormData({ productOwnerId: DEFAULT_OWNER_ID });
      } else {
        // Only show error for TenantAdmin/SysAdmin
        alert('Failed to load tenants. Please refresh the page or contact support.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isVendorAdmin) {
      // For vendors, set default owner ID immediately and skip tenant fetch
      updateFormData({ productOwnerId: DEFAULT_OWNER_ID });
      setLoading(false);
    } else if (isTenantAdmin) {
      // For TenantAdmin, fetch their tenant
      fetchAvailableTenants();
    } else if (isSysAdmin || !isVendorAdmin) {
      // For SysAdmin (including from Vendors page with prefilled vendor), fetch all tenants
      fetchAvailableTenants();
    } else {
      setLoading(false);
    }
  }, []);

  return (
    <div className="space-y-6">
      <h3 className="text-xl font-bold text-oe-text">Basic Product Details</h3>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="form-label">Product Name *</label>
          <input
            type="text"
            value={formData.name}
            onChange={(e) => updateFormData({ name: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            required
          />
        </div>

        <div>
          <label className="form-label">Product Type *</label>
          <select
            value={formData.productType}
            onChange={(e) => updateFormData({ productType: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            required
          >
            <option value="">Select Type</option>
            {PRODUCT_TYPES.map(type => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          {formData.productType === '' && (
            <p className="text-oe-error text-sm mt-1">Please select a product type</p>
          )}
        </div>

        {/* Product Owner - Show for TenantAdmin, SysAdmin, and VendorAdmin */}
        <div className="md:col-span-2">
          <label className="form-label">Product Owner (Tenant) *</label>
          {loading && !isVendorAdmin ? (
            <div className="flex items-center justify-center py-4">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-oe-primary"></div>
              <span className="ml-2 text-gray-600">Loading tenant...</span>
            </div>
          ) : isTenantAdmin ? (
            // For Tenant Admin: Show read-only field with current tenant
            <div>
              <input
                type="text"
                value={availableTenants[0]?.Name || 'Loading...'}
                readOnly
                className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-50 text-gray-700 cursor-not-allowed"
              />
              <p className="text-xs text-gray-500 mt-1">
                Your tenant is automatically selected as the product owner
              </p>
            </div>
          ) : isVendorAdmin ? (
            // For Vendor Admin: Show read-only field with Master Tenant
            <div>
              <input
                type="text"
                value="Master Tenant"
                readOnly
                className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-50 text-gray-700 cursor-not-allowed"
              />
              <p className="text-xs text-gray-500 mt-1">
                Vendor products are owned by the Master Tenant
              </p>
            </div>
          ) : (
            // SysAdmin: choose which tenant owns this product (commissions, overrides, billing)
            <>
              <select
                value={formData.productOwnerId}
                onChange={(e) => updateFormData({ productOwnerId: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                required
              >
                <option value="">Select tenant owner</option>
                {availableTenants.map(tenant => (
                  <option key={tenant.TenantId} value={tenant.TenantId}>
                    {tenant.Name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">
                Tenant owner receives unallocated commissions and owns product-level billing settings (e.g. processing fees).
              </p>
              {editingProductId && (
                <p className="text-xs text-gray-400 mt-1">
                  Changing owner keeps the previous owner subscribed to this product.
                </p>
              )}
              {formData.productOwnerId === '' && (
                <p className="text-oe-error text-sm mt-1">Please select a tenant owner</p>
              )}
              {availableTenants.length === 0 && (
                <p className="text-oe-warning text-sm mt-1">
                  No tenants available. Please create a tenant first.
                </p>
              )}
            </>
          )}
        </div>

        <div>
          <label className="form-label">Sales Type *</label>
          <select
            value={formData.salesType}
            onChange={(e) => updateFormData({ salesType: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
          >
            <option value="Individual">Individual Only</option>
            <option value="Group">Group Only</option>
            <option value="Both">Both Individual & Group</option>
          </select>
        </div>

        <div>
          <label className="form-label">Premium reporting (group billing)</label>
          <select
            value={formData.premiumReportingCategory ?? 'ForProfit'}
            onChange={(e) =>
              updateFormData({
                premiumReportingCategory: e.target.value === 'NonProfit' ? 'NonProfit' : 'ForProfit'
              })
            }
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
          >
            <option value="ForProfit">For-profit premium</option>
            <option value="NonProfit">Non-profit premium</option>
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Used to split base premium on group invoices and billing reports. Not legal/tax advice.
          </p>
        </div>

        <div>
          <label className="form-label">Effective Date Logic</label>
          <select
            value={formData.effectiveDateLogic}
            onChange={(e) => updateFormData({ effectiveDateLogic: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
          >
            <option value="SameDay">Choose Any Day</option>
            <option value="FirstOfMonth">First of Month</option>
          </select>
        </div>

        <div>
          <label className="form-label">Min Age *</label>
          <input
            type="number"
            value={formData.minAge}
            onChange={(e) => updateFormData({ minAge: parseInt(e.target.value) || 18 })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            min="0"
            max="100"
          />
        </div>

        <div>
          <label className="form-label">Max Age *</label>
          <input
            type="number"
            value={formData.maxAge}
            onChange={(e) => updateFormData({ maxAge: parseInt(e.target.value) || 65 })}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            min="0"
            max="120"
          />
        </div>
      </div>

      <div>
        <label className="form-label">Description</label>
        <textarea
          value={formData.description}
          onChange={(e) => updateFormData({ description: e.target.value })}
          rows={3}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
        />
      </div>

      <div>
        <label className="form-label">Available States *</label>
        <div className="flex gap-2 mb-3">
          <button
            type="button"
            onClick={() => updateFormData({
              allowedStates: US_STATES.map((s) => s.code)
            })}
            className="btn-secondary text-sm"
          >
            Select All
          </button>
          <button
            type="button"
            onClick={() => updateFormData({ allowedStates: [] })}
            className="btn-outline text-sm"
          >
            Deselect All
          </button>
        </div>
        <div className="max-h-40 overflow-y-auto p-4 border border-gray-300 rounded-lg bg-oe-light bg-opacity-30">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {US_STATES.map(state => (
              <label
                key={state.code}
                className="flex items-center text-sm cursor-pointer group"
              >
                <input
                  type="checkbox"
                  checked={formData.allowedStates.includes(state.code)}
                  onChange={(e) => {
                    const states = e.target.checked
                      ? [...formData.allowedStates, state.code]
                      : formData.allowedStates.filter(s => s !== state.code);
                    updateFormData({ allowedStates: states });
                  }}
                  className="form-checkbox text-oe-primary mr-2"
                />
                <span className="group-hover:text-oe-primary transition-colors">
                  {state.code}
                </span>
              </label>
            ))}
          </div>
        </div>
        <p className="text-xs text-gray-600 mt-2">
          Selected: {formData.allowedStates.length} of {US_STATES.length} states
        </p>
      </div>

      {/* Tobacco Information field hidden for now */}
      {false && (
        <div className="flex items-center">
          <input
            type="checkbox"
            checked={formData.requiresTobaccoInfo}
            onChange={(e) => updateFormData({ requiresTobaccoInfo: e.target.checked })}
            className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
          />
          <label className="ml-2 form-label mb-0">Requires Tobacco Information</label>
        </div>
      )}

      {/* Add Global Product Checkbox */}
      <div className="pt-4 border-t border-gray-200">
        <div className="flex items-start">
          <input
            type="checkbox"
            checked={formData.isPublic}
            onChange={(e) => updateFormData({ isPublic: e.target.checked })}
            className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded mt-0.5"
          />
          <div className="ml-3">
            <label className="text-sm font-medium text-gray-900">Add Global Product</label>
            <p className="text-xs text-gray-500 mt-1">
              Make this product available globally to all tenants in the marketplace
            </p>
          </div>
        </div>
      </div>

      {/* Hide from Agents Checkbox */}
      <div className="pt-2">
        <div className="flex items-start">
          <input
            type="checkbox"
            checked={formData.isHidden || false}
            onChange={(e) => updateFormData({ isHidden: e.target.checked })}
            className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded mt-0.5"
          />
          <div className="ml-3">
            <label className="text-sm font-medium text-gray-900">Hide from Agents</label>
            <p className="text-xs text-gray-500 mt-1">
              Hide this product from agents in the marketplace. Typically used for products that are part of bundles.
            </p>
          </div>
        </div>
      </div>

      {/* Require SSN Checkbox */}
      <div className="pt-2">
        <div className="flex items-start">
          <input
            type="checkbox"
            checked={formData.isSSNRequired || false}
            onChange={(e) => updateFormData({ isSSNRequired: e.target.checked })}
            className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded mt-0.5"
          />
          <div className="ml-3">
            <label className="text-sm font-medium text-gray-900">Require Social Security Number</label>
            <p className="text-xs text-gray-500 mt-1">
              If enabled, members must provide their SSN when enrolling in this product. This requirement applies to all products in an enrollment link - if any product requires SSN, it will be required for the entire enrollment.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
