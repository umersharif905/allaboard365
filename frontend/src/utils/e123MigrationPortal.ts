const ADMIN_API_BASE = '/api/admin/migration';
const TENANT_API_BASE = '/api/me/tenant-admin/e123-migration';
const ADMIN_ROUTE_PREFIX = '/admin/migration';
const TENANT_ROUTE_PREFIX = '/tenant-admin/migration';

let portalMode = false;

function detectPortalModeFromPath(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.startsWith(TENANT_ROUTE_PREFIX);
}

export function setE123MigrationPortalMode(enabled: boolean) {
  portalMode = enabled;
}

export function isE123MigrationPortalMode() {
  return portalMode || detectPortalModeFromPath();
}

export function getE123MigrationApiBase() {
  return isE123MigrationPortalMode() ? TENANT_API_BASE : ADMIN_API_BASE;
}

export function getE123MigrationRoutePrefix() {
  return isE123MigrationPortalMode() ? TENANT_ROUTE_PREFIX : ADMIN_ROUTE_PREFIX;
}

export function e123MigrationPath(suffix = '') {
  const prefix = getE123MigrationRoutePrefix();
  if (!suffix) return prefix;
  return suffix.startsWith('/') ? `${prefix}${suffix}` : `${prefix}/${suffix}`;
}

export interface E123MigrationPortalStatus {
  enabled: boolean;
  instanceId: string | null;
  label: string | null;
}
