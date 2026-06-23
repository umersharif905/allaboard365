// frontend/src/components/tenant-admin/TenantAdminLayout.tsx
import React, { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import TenantAdminNavigation from '../../components/TenantAdminNavigation';
import { useAuth } from '../../contexts/AuthContext';
import TenantAdminService from '../../services/tenant-admin/tenant-admin.service';

interface TenantAdminLayoutProps {
  children?: React.ReactNode;
}

const TenantAdminLayout: React.FC<TenantAdminLayoutProps> = ({ children }) => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tenantInfo, setTenantInfo] = useState<{ name: string; logoUrl: string }>({
    name: '',
    logoUrl: ''
  });
  const { user } = useAuth();

  useEffect(() => {
    let isMounted = true;

    const fetchTenantInfo = async () => {
      try {
        const response = await TenantAdminService.getTenantSettings();

        if (!isMounted) return;

        if (response?.success && response.data) {
          const branding = response.data.branding || {};
          const candidateLogo =
            branding.logoUrl ||
            (branding as any).logo ||
            // Support legacy casing/paths
            (response.data as any).logoUrl ||
            (response.data as any).LogoUrl ||
            (branding as any).companyLogoUrl || '';

          const candidateName =
            (response.data as any).name ||
            (response.data as any).Name ||
            (branding as any).companyName ||
            (user as any)?.tenantName ||
            user?.tenantId ||
            'Tenant Administration';

          setTenantInfo({
            name: candidateName,
            logoUrl: candidateLogo
          });
        } else {
          setTenantInfo((prev) => ({
            name:
              prev.name ||
              (user as any)?.tenantName ||
              user?.tenantId ||
              'Tenant Administration',
            logoUrl: prev.logoUrl
          }));
        }
      } catch (error) {
        console.error('Failed to load tenant header info:', error);
        if (isMounted) {
          setTenantInfo((prev) => ({
            name:
              prev.name ||
              (user as any)?.tenantName ||
              user?.tenantId ||
              'Tenant Administration',
            logoUrl: prev.logoUrl
          }));
        }
      }
    };

    fetchTenantInfo();

    return () => {
      isMounted = false;
    };
  }, [user?.tenantId]);

  return (
    <div className="min-h-screen bg-oe-neutral-light flex">
      {/* TenantAdminNavigation */}
      <TenantAdminNavigation
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        currentUser={{
          email: user?.email,
          tenantName: tenantInfo.name || (user as any)?.tenantName,
          role: user?.currentRole,
          useProfileHook: true
        }}
        title={tenantInfo.name || 'Tenant Administration'}
        subtitle="Tenant Management"
      />

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        <div className="bg-white border-b border-gray-200">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center space-x-4">
              {tenantInfo.logoUrl ? (
                <img
                  src={tenantInfo.logoUrl}
                  alt={`${tenantInfo.name} logo`}
                  className="h-12 w-12 rounded-md object-contain border border-gray-200 bg-white"
                />
              ) : (
                <div className="h-12 w-12 rounded-md bg-gray-100 flex items-center justify-center text-gray-500 font-semibold">
                  {tenantInfo.name ? tenantInfo.name.charAt(0) : 'T'}
                </div>
              )}
              <div>
                <h1 className="text-xl font-semibold text-gray-900">
                  {tenantInfo.name || 'Tenant Administration'}
                </h1>
                <p className="text-sm text-gray-500">Tenant Administration Portal</p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {children || <Outlet />}
        </div>
      </div>
    </div>
  );
};

export default TenantAdminLayout;