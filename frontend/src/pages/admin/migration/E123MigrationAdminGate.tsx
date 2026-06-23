import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../../contexts/AuthContext';

/**
 * TenantAdmin users must use /tenant-admin/migration (portal APIs + scoped instance).
 * SysAdmin users continue under /admin/migration with AdminLayout.
 */
const E123MigrationAdminGate: React.FC = () => {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary" />
      </div>
    );
  }

  const roles = user?.roles ?? [];
  const hasTenantAdmin = roles.includes('TenantAdmin');
  const hasSysAdmin = roles.includes('SysAdmin');
  const actingAsTenantAdmin = user?.currentRole === 'TenantAdmin';

  const shouldUseTenantPortal =
    hasTenantAdmin && (!hasSysAdmin || actingAsTenantAdmin);

  if (shouldUseTenantPortal) {
    const rest = location.pathname.replace(/^\/admin\/migration/, '') || '';
    return (
      <Navigate
        to={`/tenant-admin/migration${rest}${location.search}${location.hash}`}
        replace
      />
    );
  }

  if (!hasSysAdmin) {
    return <Navigate to="/tenant-admin/dashboard" replace />;
  }

  return <Outlet />;
};

export default E123MigrationAdminGate;
