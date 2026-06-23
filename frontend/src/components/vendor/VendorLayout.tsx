// frontend/src/components/vendor/VendorLayout.tsx
import React, { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useRouteBasedRole } from '../../hooks/useRouteBasedRole';
import VendorNavigation from './VendorNavigation';
import VendorHeader from './VendorHeader';

interface VendorLayoutProps {
  children?: React.ReactNode;
}

const isXlUp = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches;

const VendorLayout: React.FC<VendorLayoutProps> = ({ children }) => {
  // Default: open at xl+ (≥ 1280px), collapsed at smaller widths so detail-pane
  // routes (Members/Share Requests workspaces) get usable horizontal space.
  const [sidebarOpen, setSidebarOpen] = useState(isXlUp);
  const [vendorInfo, setVendorInfo] = useState<{ name: string; logoUrl: string }>({
    name: '',
    logoUrl: ''
  });

  // Auto-sync currentRole to "Vendor" when in vendor portal
  useRouteBasedRole();

  // Auto-collapse on resize below xl, auto-expand back at xl+ unless the user
  // has toggled it themselves since.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1280px)');
    const onChange = (e: MediaQueryListEvent) => setSidebarOpen(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    let isMounted = true;

    const loadVendorInfo = async () => {
      try {
        const { apiService } = await import('../../services/api.service');
        const response = await apiService.get<{ success: boolean; data?: any }>('/api/me/vendor/profile');

        if (!isMounted) {
          return;
        }

        if (response?.success && response.data) {
          const data = response.data;
          setVendorInfo({
            name: data.VendorName || data.vendorName || '',
            logoUrl: '' // Vendors don't have logos in the current schema
          });
        } else {
          setVendorInfo({ name: '', logoUrl: '' });
        }
      } catch (error) {
        console.error('Failed to load vendor info:', error);
        if (isMounted) {
          setVendorInfo({ name: '', logoUrl: '' });
        }
      }
    };

    loadVendorInfo();

    return () => {
      isMounted = false;
    };
  }, []);
  
  return (
    <div className="min-h-screen bg-oe-neutral-light flex">
      {/* Fixed VendorNavigation */}
      <div className="fixed top-0 left-0 h-screen z-10">
        <VendorNavigation
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
        />
      </div>
      
      {/* Main Content - with margin to account for sidebar width */}
      <div className={`flex-1 min-w-0 ${sidebarOpen ? 'ml-64' : 'ml-20'} transition-all duration-300`}>
        <div className="h-screen overflow-hidden flex flex-col min-w-0">
          <VendorHeader vendorName={vendorInfo.name} logoUrl={vendorInfo.logoUrl} />
          <div className="flex-1 min-w-0 min-h-0 overflow-y-auto overflow-x-hidden">
            {children || <Outlet />}
          </div>
        </div>
      </div>
    </div>
  );
};

export default VendorLayout;

