import React, { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useRouteBasedRole } from '../../hooks/useRouteBasedRole';
import MemberNavigation from './MemberNavigation';
import MemberHeader from './MemberHeader';
import MemberMobileDrawer from './MemberMobileDrawer';
import { MemberTenantService } from '../../services/member/member-tenant.service';
import MobileAppRedirectModal from './MobileAppRedirectModal';
import EmailVerificationBanner from '../email-verification/EmailVerificationBanner';
import ColumbusChatWidget from '../columbus/ColumbusChatWidget';

interface MemberLayoutProps {
  children?: React.ReactNode;
}

const MemberLayout: React.FC<MemberLayoutProps> = ({ children }) => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [tenantInfo, setTenantInfo] = useState<{ name: string; logoUrl: string }>({
    name: '',
    logoUrl: ''
  });

  // Auto-sync currentRole to "Member" when in member portal
  useRouteBasedRole();

  useEffect(() => {
    let isMounted = true;

    const resolveLogoUrl = async (logoUrl?: string) => {
      if (typeof logoUrl !== 'string' || !logoUrl.trim()) {
        return '';
      }
      return logoUrl.trim();
    };

    const applyTenantInfo = async (name?: string, logoUrl?: string) => {
      const resolvedLogo = await resolveLogoUrl(logoUrl);
      if (!isMounted) return;

      setTenantInfo({
        name: typeof name === 'string' ? name : '',
        logoUrl: resolvedLogo
      });
    };

    const loadTenantInfo = async () => {
      try {
        const storedTenant = localStorage.getItem('currentTenantInfo');
        if (storedTenant) {
          try {
            const parsed = JSON.parse(storedTenant);
            await applyTenantInfo(parsed?.name ?? parsed?.Name, parsed?.logoUrl ?? parsed?.LogoUrl);
          } catch (parseError) {
            console.warn('Failed to parse stored tenant info for member header:', parseError);
          }
        }

        const response = await MemberTenantService.getTenant();
        if (response?.success && response.data) {
          await applyTenantInfo(
            response.data.Name ?? response.data.name,
            response.data.LogoUrl ?? response.data.logoUrl
          );
        }
      } catch (error) {
        console.error('Failed to load member tenant header info:', error);
      }
    };

    loadTenantInfo();

    return () => {
      isMounted = false;
    };
  }, []);

  // Desktop sidebar offset; 0 on mobile, 64 open / 20 collapsed at md+
  const desktopMarginClass = sidebarOpen ? 'md:ml-64' : 'md:ml-20';

  return (
    <div className="min-h-screen bg-oe-neutral-light">
      <MobileAppRedirectModal />

      {/* Desktop sidebar (hidden on mobile) */}
      <div className="hidden md:block fixed top-0 left-0 h-screen z-10">
        <MemberNavigation
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
        />
      </div>

      {/* Mobile drawer (rendered only below md) */}
      <MemberMobileDrawer
        open={mobileDrawerOpen}
        onClose={() => setMobileDrawerOpen(false)}
      />

      {/* Main Content */}
      <div className={`${desktopMarginClass} transition-all duration-300`}>
        <div className="min-h-screen flex flex-col">
          <MemberHeader
            tenantName={tenantInfo.name}
            logoUrl={tenantInfo.logoUrl}
            onMenuClick={() => setMobileDrawerOpen(true)}
          />
          <EmailVerificationBanner />
          <div className="flex-1 p-4 md:p-6">
            {children || <Outlet />}
          </div>
        </div>
      </div>
      <ColumbusChatWidget />
    </div>
  );
};

export default MemberLayout;
