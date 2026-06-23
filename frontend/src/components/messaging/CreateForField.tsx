import { Building2, Store } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { getAllVendors, type SysAdminVendorOption } from '../../services/sysadmin/messaging-vendors.service';

interface Tenant {
  TenantId: string;
  Name: string;
}

export type CreateForMode = 'tenant' | 'vendor';

export interface CreateForValue {
  mode: CreateForMode;
  /** Required for `mode === 'tenant'`. Unused for `mode === 'vendor'` (backend infers from the vendor's users). */
  tenantId: string;
  /** Required for `mode === 'vendor'`. */
  vendorId: string | null;
}

interface CreateForFieldProps {
  tenants: Tenant[];
  value: CreateForValue;
  onChange: (next: CreateForValue) => void;
  disabled?: boolean;
}

/**
 * SysAdmin-only "Create for" picker.
 *
 *  - Segmented control: Tenant or Vendor.
 *  - Tenant mode: Tenant dropdown.
 *  - Vendor mode: SINGLE vendor dropdown listing all vendors from oe.Vendors.
 *    Vendors without portal users are rendered as disabled <option>s; the
 *    backend infers the TenantId for the new record from the vendor's
 *    oe.Users rows.
 *
 * The parent gates rendering on SysAdmin role.
 */
const CreateForField: React.FC<CreateForFieldProps> = ({ tenants, value, onChange, disabled }) => {
  const [vendors, setVendors] = useState<SysAdminVendorOption[]>([]);
  const [vendorsLoading, setVendorsLoading] = useState(false);
  const [vendorsError, setVendorsError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  // Fetch the vendor list when the user switches to Vendor mode.
  // The cleanup resets fetchedRef so React StrictMode's double-invocation in
  // dev (mount → cleanup → mount again) doesn't leave us stuck in loading state.
  useEffect(() => {
    if (value.mode !== 'vendor') return;
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    let cancelled = false;
    setVendorsLoading(true);
    setVendorsError(null);
    getAllVendors()
      .then((list) => {
        if (cancelled) return;
        setVendors(list);
      })
      .catch((err) => {
        if (cancelled) return;
        setVendorsError(err?.message || 'Failed to load vendors');
        setVendors([]);
      })
      .finally(() => {
        if (!cancelled) setVendorsLoading(false);
      });
    return () => {
      cancelled = true;
      // Reset on cleanup so a re-run (StrictMode double-invocation, parent
      // remount, etc.) is allowed to fetch again. Without this, the first
      // pass marks fetchedRef=true and gets cancelled, the second pass sees
      // fetchedRef=true and skips — leaving loading=true forever.
      fetchedRef.current = false;
    };
  }, [value.mode]);

  const setMode = (mode: CreateForMode) => {
    if (disabled) return;
    // Reset vendorId when switching modes. Preserve tenantId so it survives a Tenant→Vendor→Tenant toggle.
    onChange({ mode, tenantId: value.tenantId, vendorId: null });
  };

  const setTenant = (tenantId: string) => {
    if (disabled) return;
    onChange({ mode: value.mode, tenantId, vendorId: null });
  };

  const setVendor = (vendorId: string) => {
    if (disabled) return;
    onChange({ mode: value.mode, tenantId: value.tenantId, vendorId: vendorId || null });
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <label className="text-sm font-semibold text-gray-700">Owner *</label>
        <div className="inline-flex rounded-md border border-gray-300 overflow-hidden">
          <button
            type="button"
            onClick={() => setMode('tenant')}
            disabled={disabled}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
              value.mode === 'tenant'
                ? 'bg-oe-primary text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            <Building2 className="h-3.5 w-3.5" />
            Tenant
          </button>
          <button
            type="button"
            onClick={() => setMode('vendor')}
            disabled={disabled}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-l border-gray-300 transition-colors ${
              value.mode === 'vendor'
                ? 'bg-oe-primary text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            <Store className="h-3.5 w-3.5" />
            Vendor
          </button>
        </div>
      </div>

      {value.mode === 'tenant' ? (
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Tenant *</label>
          <select
            value={value.tenantId}
            onChange={(e) => setTenant(e.target.value)}
            disabled={disabled}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-oe-primary focus:border-oe-primary"
          >
            <option value="">Select tenant...</option>
            {tenants.map((t) => (
              <option key={t.TenantId} value={t.TenantId}>
                {t.Name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Vendor *</label>
          <select
            value={value.vendorId ?? ''}
            onChange={(e) => setVendor(e.target.value)}
            disabled={disabled || vendorsLoading}
            className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-oe-primary focus:border-oe-primary disabled:bg-gray-50 disabled:text-gray-500"
          >
            <option value="">
              {vendorsLoading
                ? 'Loading vendors...'
                : vendors.length === 0
                ? 'No vendors available'
                : 'Select vendor...'}
            </option>
            {vendors.map((v) => (
              <option
                key={v.vendorId}
                value={v.vendorId}
                disabled={!v.hasUsers}
                title={!v.hasUsers ? 'No portal users yet' : undefined}
              >
                {v.vendorName}{!v.hasUsers ? ' (no users yet)' : ''}
              </option>
            ))}
          </select>
          {vendorsError && <p className="mt-1 text-xs text-red-600">{vendorsError}</p>}
        </div>
      )}
    </div>
  );
};

export default CreateForField;
