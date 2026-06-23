export interface MigrationTenantOption {
  tenantId: string;
  name: string;
}

/** Normalize tenant rows from /api/admin/migration/tenants or /api/admin/tenants. */
export function normalizeMigrationTenant(row: {
  TenantId?: string;
  tenantId?: string;
  Name?: string;
  name?: string;
}): MigrationTenantOption | null {
  const tenantId = String(row.TenantId ?? row.tenantId ?? '').trim();
  if (!tenantId || tenantId === '00000000-0000-0000-0000-000000000000') return null;
  const name = String(row.Name ?? row.name ?? '').trim();
  return { tenantId, name: name || 'Unnamed tenant' };
}
