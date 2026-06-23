import React from 'react';

interface ScopePillProps {
  vendorId: string | null | undefined;
}

/**
 * Small pill that indicates whether a Template or Campaign is tenant-owned or vendor-owned.
 * - `vendorId == null` -> "Tenant" (gray)
 * - `vendorId != null` -> "Vendor" (oe-light brand accent)
 *
 * The pill is meaningful primarily to SysAdmin (who sees mixed lists). For consistency
 * it is rendered in TenantAdmin and VendorAdmin views as well.
 */
const ScopePill: React.FC<ScopePillProps> = ({ vendorId }) => {
  const isVendor = vendorId != null;
  if (isVendor) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-oe-light text-oe-dark">
        Vendor
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">
      Tenant
    </span>
  );
};

export default ScopePill;
