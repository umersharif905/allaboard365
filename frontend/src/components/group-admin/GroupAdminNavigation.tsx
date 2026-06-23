import {
    BarChart2,
    Settings,
    UserCog
} from 'lucide-react';
import React from 'react';
import { useAuth } from '../../contexts/AuthContext';
import SideNavigation, { NavigationItem } from '../common/SideNavigation';

interface GroupAdminNavigationProps {
  currentUser?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    role?: string;
  };
  onLogout?: () => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}

const GroupAdminNavigation: React.FC<GroupAdminNavigationProps> = ({
  currentUser,
  onLogout,
  sidebarOpen = true,
  setSidebarOpen = () => {}
}) => {
  const { logout, user: authUser } = useAuth();

  // Navigation items for GroupAdmin
  const navigationItems: NavigationItem[] = [
    { 
      path: '/group-admin/dashboard', 
      label: 'Dashboard', 
      icon: <BarChart2 size={20} />,
      description: 'Group overview and metrics'
    },
    { 
      path: '/group-admin/users', 
      label: 'User Management', 
      icon: <UserCog size={20} />,
      description: 'Manage group administrator accounts'
    },
    // { 
    //   path: '/group-admin/products', 
    //   label: 'Products', 
    //   icon: <Package size={20} />,
    //   description: 'View and manage products'
    // },
    // { 
    //   path: '/group-admin/billing', 
    //   label: 'Billing', 
    //   icon: <DollarSign size={20} />,
    //   description: 'Billing and payment history'
    // },
    // { 
    //   path: '/group-admin/documents', 
    //   label: 'Documents', 
    //   icon: <FileText size={20} />,
    //   description: 'View and manage documents'
    // },
    { 
      path: '/group-admin/settings', 
      label: 'Settings', 
      icon: <Settings size={20} />,
      description: 'Group configuration'
    }
  ];

  const handleLogout = () => {
    // If a custom logout handler is provided, use it
    if (onLogout) {
      onLogout();
    } else {
      // Otherwise use the AuthContext logout
      logout();
    }
  };

  // Create user info object
  const userInfo = currentUser || {
    email: authUser?.email,
    useProfileHook: true // This will trigger the hook to fetch full profile data
  };

  return (
    <SideNavigation
      sidebarOpen={sidebarOpen}
      setSidebarOpen={setSidebarOpen}
      title="Group Admin"
      subtitle="Business Portal"
      navigationItems={navigationItems}
      user={userInfo}
      onLogout={handleLogout}
    />
  );
};

export default GroupAdminNavigation; 