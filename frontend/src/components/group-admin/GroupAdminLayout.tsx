// frontend/src/components/group-admin/GroupAdminLayout.tsx
import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useRouteBasedRole } from '../../hooks/useRouteBasedRole';
import GroupAdminNavigation from './GroupAdminNavigation';

interface GroupAdminLayoutProps {
  children?: React.ReactNode;
}

const GroupAdminLayout: React.FC<GroupAdminLayoutProps> = ({ children }) => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  console.log('GroupAdminLayout - sidebarOpen:', sidebarOpen);
  
  // Auto-sync currentRole to "GroupAdmin" when in group-admin portal
  useRouteBasedRole();

  return (
    <div className="min-h-screen bg-oe-neutral-light flex">
      {/* Fixed GroupAdminNavigation */}
      <div className="fixed top-0 left-0 h-screen z-10">
        <GroupAdminNavigation
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
        />
      </div>
      
      {/* Main Content - with margin to account for sidebar width */}
      <div className={`flex-1 min-w-0 ${sidebarOpen ? 'ml-64' : 'ml-20'} transition-all duration-300`}>
        <div className="h-screen overflow-y-auto">
          {children || <Outlet />}
        </div>
      </div>
    </div>
  );
};

export default GroupAdminLayout;
