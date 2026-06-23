import { apiService } from '../api.service';

export interface SysAdminVendorOption {
  vendorId: string;
  vendorName: string;
  /** True iff the vendor has at least one row in oe.Users (i.e. is messaging-eligible). */
  hasUsers: boolean;
  /** Any TenantId from the vendor's users; null if the vendor has no users. */
  defaultTenantId: string | null;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

/**
 * SysAdmin: list of ALL vendors (tenant-agnostic).
 *
 * Each entry carries `hasUsers` (gates dropdown selection) and `defaultTenantId`
 * (informational; the backend infers TenantId for vendor-scoped templates from
 * oe.Users when the POST is made).
 *
 * Backend: GET /api/me/sysadmin/vendors
 */
export async function getAllVendors(): Promise<SysAdminVendorOption[]> {
  const res = await apiService.get<ApiResponse<SysAdminVendorOption[]>>(
    `/api/me/sysadmin/vendors`
  );
  if (res?.success && Array.isArray(res.data)) return res.data;
  return [];
}
