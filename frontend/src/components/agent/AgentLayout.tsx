// frontend/src/components/agent/AgentLayout.tsx
import React, { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useRouteBasedRole } from '../../hooks/useRouteBasedRole';
import { AgentService } from '../../services/agent/agent.service';
import AgentHeader from './AgentHeader';
import AgentNavigation from './AgentNavigation';
import { AgentProfileValidationProvider } from '../../contexts/AgentProfileValidationContext';
import { AgentTrainingIncompleteProvider } from '../../contexts/AgentTrainingIncompleteContext';
import { AgentSidebarProvider } from '../../contexts/AgentSidebarContext';
import AgentColumbusChatWidget from '../columbus/AgentColumbusChatWidget';

interface AgentLayoutProps {
  children?: React.ReactNode;
}

const AgentLayout: React.FC<AgentLayoutProps> = ({ children }) => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const location = useLocation();
  const isTrainingPath = location.pathname.startsWith('/agent/training');
  const [tenantInfo, setTenantInfo] = useState<{ name: string; logoUrl: string }>({
    name: '',
    logoUrl: ''
  });
  // Auto-sync currentRole to "Agent" when in agent portal
  useRouteBasedRole();

  useEffect(() => {
    let isMounted = true;

    const loadTenantInfo = async () => {
      try {
        const response = await AgentService.getAgentTenant();

        if (!isMounted) {
          return;
        }

        if (response?.success && response.data) {
          const data = response.data;

          const rawAdvanced = data?.AdvancedSettings ?? data?.advancedSettings ?? null;
          let advancedSettings: any = null;
          if (rawAdvanced) {
            try {
              advancedSettings = typeof rawAdvanced === 'string' ? JSON.parse(rawAdvanced) : rawAdvanced;
            } catch (parseError) {
              console.warn('AgentLayout: Failed to parse AdvancedSettings JSON', parseError);
            }
          }

          const branding = advancedSettings?.branding ?? advancedSettings ?? {};

          const rawName =
            data?.TenantName ??
            data?.tenantName ??
            data?.Name ??
            data?.name ??
            branding?.companyName ??
            branding?.tenantName ??
            '';

          const rawLogo =
            data?.LogoUrl ??
            data?.logoUrl ??
            data?.TenantLogoUrl ??
            data?.tenantLogoUrl ??
            branding?.logoUrl ??
            branding?.tenantLogoUrl ??
            advancedSettings?.logoUrl ??
            '';

          setTenantInfo({
            name: typeof rawName === 'string' ? rawName : '',
            logoUrl: typeof rawLogo === 'string' ? rawLogo : ''
          });
        } else {
          setTenantInfo({ name: '', logoUrl: '' });
        }
      } catch (error) {
        console.error('Failed to load agent tenant header info:', error);
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

  /** Training uses icon rail (w-20); other agent routes use full expandable sidebar like before. */
  const trainingRailLocked = isTrainingPath;
  const navSidebarOpen = trainingRailLocked ? false : sidebarOpen;
  const navSetSidebarOpen = trainingRailLocked ? () => {} : setSidebarOpen;

  const effectiveSidebarOpen = navSidebarOpen;

  return (
    <AgentTrainingIncompleteProvider>
    <AgentProfileValidationProvider>
    <AgentSidebarProvider value={{ sidebarOpen: effectiveSidebarOpen }}>
      <div className="min-h-screen bg-oe-neutral-light flex">
        <div className="fixed top-0 left-0 h-screen z-10">
          <AgentNavigation sidebarOpen={navSidebarOpen} setSidebarOpen={navSetSidebarOpen} />
        </div>

        {/* Main Content - with margin to account for sidebar width */}
        <div
          className={`flex-1 min-w-0 ${
            trainingRailLocked ? 'ml-20' : navSidebarOpen ? 'ml-64' : 'ml-20'
          } transition-all duration-300`}
        >
          <div className="h-screen overflow-y-auto flex flex-col">
            <AgentHeader tenantName={tenantInfo.name} logoUrl={tenantInfo.logoUrl} />
            <div className="flex-1 min-h-0 overflow-auto">
              {children || <Outlet />}
            </div>
          </div>
        </div>
        <AgentColumbusChatWidget />
      </div>
    </AgentSidebarProvider>
    </AgentProfileValidationProvider>
    </AgentTrainingIncompleteProvider>
  );
};

export default AgentLayout;





