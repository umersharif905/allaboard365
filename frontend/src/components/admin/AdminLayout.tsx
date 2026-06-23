// frontend/src/components/admin/AdminLayout.tsx
import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useRouteBasedRole } from '../../hooks/useRouteBasedRole';
import AdminNavigation from '../AdminNavigation';

interface AdminLayoutProps {
  children?: React.ReactNode;
}

const AdminLayout: React.FC<AdminLayoutProps> = ({ children }) => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  
  // Auto-sync currentRole to "SysAdmin" when in admin portal
  useRouteBasedRole();
  
  return (
    <div className="min-h-screen h-screen flex bg-oe-neutral-light overflow-hidden">
      {/* AdminNavigation - Fixed */}
      <AdminNavigation
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
      />
      {/* Main Content - fills remaining height so Message Center etc. can use h-full */}
      <div className={`flex-1 min-h-0 flex flex-col transition-all duration-300 ease-in-out ${sidebarOpen ? 'ml-64' : 'ml-20'}`}>
        <div className="flex-1 min-h-0 overflow-auto">
          {children || <Outlet />}
        </div>
      </div>
    </div>
  );
};

export default AdminLayout; 