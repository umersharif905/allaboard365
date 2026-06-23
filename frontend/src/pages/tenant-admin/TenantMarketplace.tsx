/**
 * Tenant admin marketplace — same UI as SysAdmin marketplace.
 * Listing and subscription use /api/marketplace/* with requireTenantAccess so
 * x-current-tenant-id (tenant switching) applies consistently.
 */
export { default } from '../admin/marketplace';
