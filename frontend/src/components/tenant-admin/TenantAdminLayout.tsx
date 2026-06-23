// frontend/src/components/tenant-admin/TenantAdminLayout.tsx
import React, { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useRouteBasedRole } from '../../hooks/useRouteBasedRole';
import TenantAdminService from '../../services/tenant-admin/tenant-admin.service';
import TenantAdminNavigation from '../TenantAdminNavigation';
import TenantAdminHeader from './TenantAdminHeader';

interface TenantAdminLayoutProps {
  children?: React.ReactNode;
}

const TenantAdminLayout: React.FC<TenantAdminLayoutProps> = ({ children }) => {
  const { user } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const location = useLocation();
  const [tenantInfo, setTenantInfo] = useState<{ name: string; logoUrl: string }>({
    name: '',
    logoUrl: ''
  });
  
  // Auto-sync currentRole to "TenantAdmin" when in tenant-admin portal
  useRouteBasedRole();

  useEffect(() => {
    let isMounted = true;

    const loadTenantInfo = async () => {
      try {
        const response = await TenantAdminService.getTenantSettings();

        if (!isMounted) {
          return;
        }

        if (response?.success && response.data) {
          const branding = response.data.branding || {};
          const rawName =
            (response.data as any).name ??
            (response.data as any).Name ??
            (branding as any).companyName ??
            '';
          const rawLogo =
            branding.logoUrl ||
            (branding as any).logo ||
            (response.data as any).logoUrl ||
            (response.data as any).LogoUrl ||
            (branding as any).companyLogoUrl ||
            '';

          setTenantInfo({
            name: typeof rawName === 'string' ? rawName : '',
            logoUrl: typeof rawLogo === 'string' ? rawLogo : ''
          });
        } else {
          setTenantInfo({ name: '', logoUrl: '' });
        }
      } catch (error) {
        console.error('Failed to load tenant header info:', error);
        if (isMounted) {
          setTenantInfo({ name: '', logoUrl: '' });
        }
      }
    };

    loadTenantInfo();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const trainingPath = location.pathname.startsWith('/tenant-admin/training');
    if (!trainingPath) {
      return;
    }

    const collapseThresholdPx = 1280;
    const applyCollapseRule = (): void => {
      if (window.innerWidth < collapseThresholdPx) {
        setSidebarOpen(false);
      }
    };

    applyCollapseRule();
    window.addEventListener('resize', applyCollapseRule);
    return () => {
      window.removeEventListener('resize', applyCollapseRule);
    };
  }, [location.pathname]);
  
  return (
    <div className="min-h-screen bg-oe-neutral-light flex">
      {/* Fixed TenantAdminNavigation */}
      <div className="fixed top-0 left-0 h-screen z-10">
        <TenantAdminNavigation
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          title={tenantInfo.name || 'Tenant Administration'}
          subtitle="Tenant Management"
          currentUser={{
            email: user?.email,
            tenantName: tenantInfo.name || undefined,
            role: user?.currentRole,
            useProfileHook: true,
          }}
        />
      </div>
      
      {/* Main Content - with margin to account for sidebar width */}
      <div className={`flex-1 min-w-0 ${sidebarOpen ? 'ml-64' : 'ml-20'} transition-all duration-300`}>
        <div className="h-screen overflow-y-auto flex flex-col">
          <TenantAdminHeader tenantName={tenantInfo.name} logoUrl={tenantInfo.logoUrl} />
          <div className="flex-1 overflow-auto">
            {children || <Outlet />}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TenantAdminLayout;